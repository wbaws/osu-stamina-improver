/**
 * osu! Stamina Improver - global leaderboard (D1 edition).
 * Storage: Cloudflare D1 (free tier ~100k writes/day, 5M rows read/day, zero list
 * operations). Replaces the KV implementation whose 1,000/day list-op cap we
 * exhausted on launch day. D1 Time Travel keeps 30 days of point-in-time backup.
 * API shape and anti-cheat are identical to the KV version.
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

const nowISO = () => new Date().toISOString();
const keyFor = name => name.toLowerCase().replace(/[^a-z0-9_ -]/g, '');

/* ---------------- level formula (mirror of index.html) ---------------- */
function staminaSpec(cyc, k) {
  // stretch (2026-08-30): the old 1-160 difficulty now spans 1-200;
  // bpm/UR grow at 2/3 speed via a virtual stamina index, notes stay real
  const step = 5 * cyc + k;
  const vsf = step * 2 / 3;
  const vk = Math.floor(vsf + 1e-9);
  const bpm = Math.round(170 + 2 * vsf + Math.floor(vsf / 10));
  let ur = 200 - 5 * (vk % 5);
  const vcyc = Math.floor(vk / 5);
  if (vcyc >= 1) ur -= 20 + 4 * (vcyc - 1);
  ur = Math.max(95, ur);
  // notes nerf (2026-08-30): +16 per stamina level from the 64-note base (L80),
  // switching to +32 per stamina level from L130 — no marathon jumps
  let notes = step <= 24 ? 64 + 16 * step : 448 + 32 * (step - 24);
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
      // burst nerf (2026-08-30): 12 notes from L110 on, 8 before
  const bnotes = L >= 110 ? 12 : 8;
  return { bpm: base.bpm * (330 / 270), ur: base.ur, notes: bnotes, burst: true };
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

/* ---------------- row <-> entry mapping ---------------- */
function rowToEntry(r) {
  return {
    name: r.name,
    level: r.level,
    bpm: r.bpm,
    ur: r.ur,
    plays: r.plays,
    totalTaps: r.total_taps,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    bestAt: r.best_at,
  };
}

const SELECT_ALL = 'SELECT * FROM players ORDER BY level DESC, bpm DESC';

async function getPlayer(db, key) {
  const r = await db.prepare('SELECT * FROM players WHERE key = ?1').bind(key).first();
  return r || null;
}

async function upsertPlayer(db, p) {
  await db.prepare(
    'INSERT INTO players (name, key, level, bpm, ur, plays, total_taps, first_seen, last_seen, best_at, last_hash) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ' +
    'ON CONFLICT(key) DO UPDATE SET name=?1, level=?3, bpm=?4, ur=?5, plays=?6, total_taps=?7, last_seen=?9, best_at=?10, last_hash=?11'
  ).bind(p.name, p.key, p.level, p.bpm, p.ur, p.plays, p.totalTaps, p.firstSeen, p.lastSeen, p.bestAt, p.lastHash || null).run();
}

async function handleFetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = env.DB;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, worker: 'osi-leaderboard', storage: 'd1', time: nowISO() });
    }

    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const rs = await db.prepare(SELECT_ALL + ' LIMIT ?1').bind(limit).all();
      const ranked = (rs.results || []).map((r, i) => {
        const e = rowToEntry(r);
        e.rank = i + 1;
        return e;
      });
      return json({ leaderboard: ranked, generatedAt: nowISO() });
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      const agg = await db.prepare(
        'SELECT COUNT(*) AS players, MAX(level) AS bestLevel, SUM(total_taps) AS totalTaps, SUM(plays) AS totalPlays FROM players'
      ).first();
      const buckets = await db.prepare(
        'SELECT (level / 25) * 25 AS bucket, COUNT(*) AS count FROM players GROUP BY bucket ORDER BY bucket'
      ).all();
      const avg = await db.prepare('SELECT AVG(bpm) AS avgTopBpm FROM players WHERE bpm > 0').first();
      return json({
        players: agg.players || 0,
        bestLevel: agg.bestLevel || 0,
        totalTaps: agg.totalTaps || 0,
        totalPlays: agg.totalPlays || 0,
        avgTopBpm: avg && avg.avgTopBpm ? Math.round(avg.avgTopBpm * 10) / 10 : 0,
        levelBuckets: (buckets.results || []).map(b => ({ bucket: b.bucket, label: b.bucket + '-' + (b.bucket + 24), count: b.count })),
        generatedAt: nowISO(),
      });
    }

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return bad('invalid json'); }

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
      if (!(bpm >= spec.bpm && ur < spec.ur)) return bad('score does not meet the level requirements', 422);
      if (!plausible({ bpm, ur, notes, elapsedMs })) return bad('physically implausible', 422);
      const proofResult = checkProof({ bpm, ur, notes, elapsedMs, proof: body.proof }, spec);
      if (!proofResult) return bad('proof invalid or missing', 422);

      const key = keyFor(name);
      if (!key) return bad('bad name');

      const existing = await getPlayer(db, key);
      const hash = await bodyHash({ name, notes, bpm, ur, elapsedMs });
      if (existing && existing.last_hash && existing.last_hash === hash) return bad('replay', 409);

      const now = nowISO();
      const prev = existing ? rowToEntry(existing) : { level: 0, plays: 0, totalTaps: 0, firstSeen: now };
      const better = level >= prev.level;
      await upsertPlayer(db, {
        name,
        key,
        level: better ? level : prev.level,
        bpm: better ? bpm : prev.bpm,
        ur: better ? ur : prev.ur,
        plays: (prev.plays || 0) + 1,
        totalTaps: (prev.totalTaps || 0) + notes,
        firstSeen: existing ? existing.first_seen : now,
        lastSeen: now,
        bestAt: better ? now : (existing ? existing.best_at : now),
        lastHash: hash,
      });
      return json({ ok: true, level: better ? level : prev.level });
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

      const key = keyFor(name);
      if (!key) return bad('bad name');

      const existing = await getPlayer(db, key);
      const hash = await bodyHash({ name, notes, bpm, ur, elapsedMs });
      if (existing && existing.last_hash && existing.last_hash === hash) return bad('replay', 409);

      const now = nowISO();
      const prev = existing ? rowToEntry(existing) : { level: 0, plays: 0, totalTaps: 0, firstSeen: now };
      await upsertPlayer(db, {
        name,
        key,
        level: prev.level || 0,
        bpm: prev.level ? prev.bpm : bpm,
        ur: prev.level ? prev.ur : ur,
        plays: (prev.plays || 0) + 1,
        totalTaps: (prev.totalTaps || 0) + notes,
        firstSeen: existing ? existing.first_seen : now,
        lastSeen: now,
        bestAt: existing ? existing.best_at : now,
        lastHash: hash,
      });
      return json({ ok: true, totalTaps: (prev.totalTaps || 0) + notes });
    }

    return bad('not found', 404);
}

export async function onRequest(context) {
  return handleFetch(context.request, context.env, undefined);
}
