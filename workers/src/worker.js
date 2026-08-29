/**
 * osu! Stamina Improver — global leaderboard worker.
 * Free hosting on Cloudflare Workers free tier; data in a KV namespace.
 *
 * Endpoints:
 *   GET  /api/health        -> { ok: true }
 *   GET  /api/leaderboard   -> top players
 *   GET  /api/stats         -> global aggregate stats
 *   POST /api/submit        -> submit a cleared level (validated)
 *
 * Validation mirrors the game's own math (index.html): stream bpm =
 * (clicks/elapsedMs)*60000/4, UR = 10 * stdev(intervals), and the exact
 * levelSpec() formula. The client must send the raw click-time proof, and
 * the server recomputes everything — forged numbers are rejected.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

/* per-isolate 30s read cache: keeps leaderboard/stats well inside free-tier limits */
const MEM = { lb: { at: 0, data: null }, stats: { at: 0, data: null } };
const CACHE_TTL = 30000;

/* ---------------- level formula (mirror of index.html) ---------------- */
function staminaSpec(cyc, k) {
  const bpm = 170 + 2 * (5 * cyc + k) + Math.floor(cyc / 2);
  let ur = 200 - 5 * k;
  if (cyc >= 1) ur -= 20 + 4 * (cyc - 1);
  ur = Math.max(95, ur);
  let notes;
  if (cyc === 0) notes = 64 + 16 * k;
  else if (cyc === 1) notes = 1024 + 32 * k;
  else notes = 1024 * Math.pow(2, cyc - 1) + 16 * Math.pow(2, cyc) * k;
  notes = Math.min(10000, Math.round(notes));
  return { bpm, ur, notes };
}

function specForLevel(L) {
  L = Math.max(1, Math.floor(L));
  if (L <= 79) {
    const t = (L - 1) / 79;
    return {
      bpm: Math.round(100 + 70 * t),
      ur: Math.round(350 - 150 * t),
      notes: Math.round(6 + 58 * t),
      burst: false,
    };
  }
  const idx = L - 80;
  const cyc = Math.floor(idx / 10);
  const pos = idx % 10;
  if (pos % 2 === 1) {
    const base = staminaSpec(cyc, (pos - 1) / 2);
    return { bpm: base.bpm * (330 / 270), ur: base.ur, notes: 8, burst: true };
  }
  return staminaSpec(cyc, pos / 2);
}

/* ---------------- proof check: recompute the run from raw click times ---------------- */
function checkProof(sub, spec) {
  if (!sub.proof || typeof sub.proof !== 'object') return null;
  const clicks = Array.isArray(sub.proof.clicks) ? sub.proof.clicks : null;
  if (!clicks || clicks.length < 2 || clicks.length > 20000) return null;
  let prev = null;
  const intervals = [];
  let strictlyIncreasing = true;
  for (const c of clicks) {
    if (!Number.isFinite(c) || c < 0) return null;
    if (prev !== null) {
      if (c <= prev) strictlyIncreasing = false;
      intervals.push(c - prev);
    }
    prev = c;
  }
  if (!strictlyIncreasing) return null;
  const n = clicks.length;
  const elapsed = clicks[n - 1] - clicks[0];
  if (elapsed <= 0) return null;
  const bpm = (n / elapsed) * 60000 / 4;
  let mean = 0;
  for (const d of intervals) mean += d;
  mean /= intervals.length;
  let ss = 0;
  for (const d of intervals) ss += (d - mean) * (d - mean);
  const ur = 10 * Math.sqrt(ss / intervals.length);
  const ok =
    Math.abs(bpm - sub.bpm) < 1e-6 &&
    Math.abs(ur - sub.ur) < 1e-6 &&
    Math.abs(elapsed - sub.elapsedMs) < 1e-6 &&
    n === sub.notes &&
    (!spec || (bpm >= spec.bpm && ur < spec.ur));
  return ok ? { bpm, ur, elapsed, n } : null;
}

/* light physical-plausibility gate (applies to the proof-verified numbers) */
function plausible(sub) {
  const { bpm, ur, notes, elapsedMs } = sub;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 150) return false;
  const avgInterval = elapsedMs / Math.max(1, notes - 1);
  if (avgInterval < 12) return false; // > ~83 clicks/sec sustained: not human
  if (notes >= 20) {
    const elapsedFromBpm = notes * 15000 / bpm;
    const ratio = elapsedMs / elapsedFromBpm;
    if (ratio < 0.5 || ratio > 2.5) return false;
  }
  if (ur < 0 || ur > 1000) return false;
  return true;
}
/* immediate-replay guard: reject the exact same run payload twice in a row */
async function bodyHash(sub) {
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify({ name: sub.name, notes: sub.notes, bpm: sub.bpm, ur: sub.ur, elapsedMs: sub.elapsedMs }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadAll(env) {
  const entries = [];
  let cursor = undefined;
  do {
    const page = await env.LEADERBOARD.list({ cursor });
    for (const k of page.keys) {
      const v = await env.LEADERBOARD.get(k.name, 'json');
      if (v) entries.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, worker: 'osi-leaderboard', time: new Date().toISOString() });
    }

    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      if (MEM.lb.data && Date.now() - MEM.lb.at < CACHE_TTL) return json(MEM.lb.data);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const entries = await loadAll(env);
      entries.sort((a, b) => b.level - a.level || (b.bpm || 0) - (a.bpm || 0));
      const ranked = entries.slice(0, limit).map((e, i) => ({
        rank: i + 1,
        name: e.name,
        level: e.level,
        bpm: e.bpm,
        ur: e.ur,
        plays: e.plays || 1,
        totalTaps: e.totalTaps || 0,
        bestAt: e.bestAt || e.firstSeen || e.lastSeen,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      }));
      const payload = { leaderboard: ranked, generatedAt: new Date().toISOString() };
      MEM.lb = { at: Date.now(), data: payload };
      return json(payload);
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      if (MEM.stats.data && Date.now() - MEM.stats.at < CACHE_TTL) return json(MEM.stats.data);
      const entries = await loadAll(env);
      let totalTaps = 0, totalPlays = 0, best = 0;
      const levelHistogram = {};
      let bpmSum = 0, bpmCount = 0;
      for (const e of entries) {
        totalTaps += e.totalTaps || 0;
        totalPlays += e.plays || 1;
        if (e.level > best) best = e.level;
        const b = Math.floor(e.level / 25) * 25;
        levelHistogram[b] = (levelHistogram[b] || 0) + 1;
        if (e.bpm > 0) { bpmSum += e.bpm; bpmCount++; }
      }
      const avgBpm = bpmCount ? Math.round((bpmSum / bpmCount) * 10) / 10 : 0;
      const buckets = Object.entries(levelHistogram)
        .map(([b, count]) => ({ bucket: Number(b), label: b + '-' + (Number(b) + 24), count }))
        .sort((x, y) => x.bucket - y.bucket);
      const payload = {
        players: entries.length,
        bestLevel: best,
        totalTaps,
        totalPlays,
        avgTopBpm: avgBpm,
        levelBuckets: buckets,
        generatedAt: new Date().toISOString(),
      };
      MEM.stats = { at: Date.now(), data: payload };
      return json(payload);
    }

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return bad('invalid json');
      }

      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 16) : '';
      if (!name) return bad('missing name');

      const level = Math.floor(Number(body.level));
      if (!Number.isFinite(level) || level < 1 || level > 5000) return bad('bad level');

      const bpm = Number(body.bpm);
      const ur = Number(body.ur);
      const notes = Math.floor(Number(body.notes));
      const elapsedMs = Number(body.elapsedMs);
      if (!Number.isFinite(bpm) || !Number.isFinite(ur) || !Number.isFinite(notes) || !Number.isFinite(elapsedMs)) {
        return bad('bad numbers');
      }

      const spec = specForLevel(level);
      if (notes !== spec.notes) return bad('note count mismatch', 422);
      if (!(bpm >= spec.bpm && ur < spec.ur)) {
        return bad('score does not meet the level requirements', 422);
      }
      if (!plausible({ bpm, ur, notes, elapsedMs })) {
        return bad('physically implausible', 422);
      }
      const proofResult = checkProof({ bpm, ur, notes, elapsedMs, proof: body.proof }, spec);
      if (!proofResult) return bad('proof invalid or missing', 422);

      const key = 'lb:' + name.toLowerCase().replace(/[^a-z0-9_ -]/g, '');
      if (key === 'lb:') return bad('bad name');

      const existing = (await env.LEADERBOARD.get(key, 'json')) || {};
      const hash = await bodyHash({ name, notes, bpm, ur, elapsedMs });
      if (existing.lastHash && existing.lastHash === hash) return bad('replay', 409);
      const now = new Date().toISOString();
      const better = level >= (existing.level || 0);
      const entry = {
        name,
        level: better ? level : existing.level,
        bpm: better ? bpm : existing.bpm,
        ur: better ? ur : existing.ur,
        plays: (existing.plays || 0) + 1,
        totalTaps: (existing.totalTaps || 0) + notes,
        bestAt: better ? now : (existing.bestAt || existing.lastSeen || now),
        lastHash: hash,
        firstSeen: existing.firstSeen || now,
        lastSeen: now,
      };
      await env.LEADERBOARD.put(key, JSON.stringify(entry));
      MEM.lb.at = 0; MEM.stats.at = 0; // next read reflects this submit
      return json({ ok: true, level: entry.level });
    }

    if (url.pathname === '/api/taps' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return bad('invalid json'); }
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 16) : '';
      if (!name) return bad('missing name');
      const notes = Math.floor(Number(body.notes));
      const bpm = Number(body.bpm);
      const ur = Number(body.ur);
      const elapsedMs = Number(body.elapsedMs);
      if (!Number.isFinite(bpm) || !Number.isFinite(ur) || !Number.isFinite(notes) || !Number.isFinite(elapsedMs)) return bad('bad numbers');
      if (notes < 2 || notes > 10000) return bad('bad notes');
      if (!plausible({ bpm, ur, notes, elapsedMs })) return bad('physically implausible', 422);
      const proofResult = checkProof({ bpm, ur, notes, elapsedMs, proof: body.proof }, null);
      if (!proofResult) return bad('proof invalid or missing', 422);
      const key = 'lb:' + name.toLowerCase().replace(/[^a-z0-9_ -]/g, '');
      if (key === 'lb:') return bad('bad name');
      const existing = (await env.LEADERBOARD.get(key, 'json')) || {
        name, level: 0, bpm, ur, plays: 0, totalTaps: 0,
        firstSeen: new Date().toISOString(), bestAt: new Date().toISOString(),
      };
      const hash = await bodyHash({ name, notes, bpm, ur, elapsedMs });
      if (existing.lastHash && existing.lastHash === hash) return bad('replay', 409);
      const now = new Date().toISOString();
      const entry = { ...existing, plays: (existing.plays || 0) + 1, totalTaps: (existing.totalTaps || 0) + notes, lastSeen: now, lastHash: hash };
      await env.LEADERBOARD.put(key, JSON.stringify(entry));
      MEM.lb.at = 0; MEM.stats.at = 0;
      return json({ ok: true, totalTaps: entry.totalTaps });
    }
    return bad('not found', 404);
  },
};
