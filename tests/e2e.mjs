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
const notes = 1024;
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
const RUN = 'E2E-' + Date.now().toString(36);

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

const me = await waitFor('leaderboard entry', async () => {
  const lb = await (await fetch(BASE + '/api/leaderboard')).json();
  const row = (lb.leaderboard || []).find(e => e.name === RUN);
  return { ok: !!row && row.level === 90, value: row };
});
check('leaderboard shows ' + RUN + ' at level 90', me && me.level === 90, JSON.stringify(me || null));

const st = await waitFor('stats update', async () => {
  const s = await (await fetch(BASE + '/api/stats')).json();
  return { ok: s.players >= 1 && s.totalTaps >= notes, value: s };
});
check('stats include the run', st && st.players >= 1 && st.totalTaps >= notes, JSON.stringify(st || null));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
