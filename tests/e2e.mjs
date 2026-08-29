/* End-to-end test against the deployed leaderboard API.
   Retries account for KV eventual consistency (list can lag writes ~60s). */
const BASE = process.env.OSI_API_BASE || 'https://osu-stamina-improver.pages.dev';
let failed = 0, passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last && last.ok) return last.value;
    await sleep(5000);
  }
  return last && last.value;
}

/* simulate a real level 90 clear: 1024 notes at ~185 stream bpm */
const notes = 144;
const interval = 15000 / 185;
const clicks = [];
let t = 0;
for (let i = 0; i < notes; i++) { clicks.push(Math.round(t * 1000) / 1000); t += interval; }
const elapsed = clicks[clicks.length - 1] - clicks[0];
const bpm = (notes / elapsed) * 60000 / 4;
const diffs = [];
for (let i = 1; i < clicks.length; i++) diffs.push(clicks[i] - clicks[i - 1]);
const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
let ss = 0;
for (const d of diffs) ss += (d - mean) * (d - mean);
const ur = 10 * Math.sqrt(ss / diffs.length);
const RUN = 'e2e-' + Date.now().toString(36);

/* helper: build a synthetic run */
function makeRun(n, targetBpm) {
  const iv = 15000 / targetBpm;
  const c = [];
  let tt = 0;
  for (let i = 0; i < n; i++) { c.push(Math.round(tt * 1000) / 1000); tt += iv; }
  const el = c[c.length - 1] - c[0];
  const b = (n / el) * 60000 / 4;
  const ds = [];
  for (let i = 1; i < c.length; i++) ds.push(c[i] - c[i - 1]);
  const m = ds.reduce((a, x) => a + x, 0) / ds.length;
  let s2 = 0;
  for (const d of ds) s2 += (d - m) * (d - m);
  return { clicks: c, elapsed: el, bpm: b, ur: 10 * Math.sqrt(s2 / ds.length) };
}

const health = await (await fetch(BASE + '/api/health')).json();
check('health ok', health.ok === true, JSON.stringify(health));

const forged = await fetch(BASE + '/api/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, level: 500, bpm: 400, ur: 100, notes: 10000, elapsedMs: 400000 })
});
check('forged submission rejected (422)', forged.status === 422, 'status ' + forged.status);

const mismatch = await fetch(BASE + '/api/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, level: 90, bpm: 999, ur: ur, notes: notes, elapsedMs: elapsed, proof: { clicks } })
});
check('proof mismatch rejected (422)', mismatch.status === 422, 'status ' + mismatch.status);

const sub = await fetch(BASE + '/api/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, level: 90, bpm, ur, notes, elapsedMs: elapsed, proof: { clicks } })
});
const subJson = await sub.json();
check('valid submission accepted', sub.status === 200 && subJson.ok === true, JSON.stringify(subJson));

const dup = await fetch(BASE + '/api/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, level: 90, bpm, ur, notes, elapsedMs: elapsed, proof: { clicks } })
});
check('identical resubmit rejected (409)', dup.status === 409, 'status ' + dup.status);

/* ---- total taps: failed/stopped runs accumulate ---- */
const run2 = makeRun(300, 172);   // a failed attempt: 300 notes, no level passed
const taps1 = await fetch(BASE + '/api/taps', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, notes: run2.clicks.length, bpm: run2.bpm, ur: run2.ur, elapsedMs: run2.elapsed, proof: { clicks: run2.clicks } })
});
const taps1j = await taps1.json().catch(() => ({}));
check('taps accepted', taps1.status === 200 && taps1j.ok === true, JSON.stringify(taps1j));
check('total taps accumulated (144 + 300)', taps1j.totalTaps === notes + run2.clicks.length, JSON.stringify(taps1j));

const taps2 = await fetch(BASE + '/api/taps', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, notes: run2.clicks.length, bpm: run2.bpm, ur: run2.ur, elapsedMs: run2.elapsed, proof: { clicks: run2.clicks } })
});
check('taps replay rejected (409)', taps2.status === 409, 'status ' + taps2.status);

const taps3 = await fetch(BASE + '/api/taps', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: RUN, notes: 500, bpm: 200, ur: 50, elapsedMs: 37000 })
});
check('forged taps rejected (422)', taps3.status === 422, 'status ' + taps3.status);

const taps4 = await fetch(BASE + '/api/taps', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'nobody-' + RUN, notes: run2.clicks.length, bpm: run2.bpm, ur: run2.ur, elapsedMs: run2.elapsed, proof: { clicks: run2.clicks } })
});
const taps4j = await taps4.json().catch(() => ({}));
check('unknown player taps create entry (200)', taps4.status === 200 && taps4j.ok === true && taps4j.totalTaps === run2.clicks.length, JSON.stringify(taps4j));

const me = await waitFor('leaderboard entry', async () => {
  const lb = await (await fetch(BASE + '/api/leaderboard')).json();
  const row = (lb.leaderboard || []).find(e => e.name === RUN);
  return { ok: !!row && row.level === 90 && row.totalTaps === notes + run2.clicks.length, value: row };
});
check('leaderboard row: level 90, totalTaps 444', me && me.level === 90 && me.totalTaps === notes + run2.clicks.length, JSON.stringify(me || null));
check('row has submitted timestamp', me && !!me.bestAt, JSON.stringify(me || null));

const st = await waitFor('stats update', async () => {
  const s = await (await fetch(BASE + '/api/stats')).json();
  return { ok: s.players >= 1 && s.totalTaps >= notes + run2.clicks.length, value: s };
});
check('stats include the run', st && st.players >= 1 && st.totalTaps >= notes + run2.clicks.length, JSON.stringify(st || null));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
