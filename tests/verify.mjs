/* Verification suite for osu! Stamina Improver.
   Runs the game's own pure logic (extracted from index.html) and
   cross-checks the leaderboard worker's level formula against it. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ---- load game logic from index.html ---- */
const html = readFileSync(here('../index.html'), 'utf8');
const m = html.match(/<script>\n('use strict';[\s\S]*?)<\/script>/);
if (!m) { console.error('FATAL: game script not found in index.html'); process.exit(1); }
const mod = { exports: {} };
new Function('module', m[1])(mod);
const { levelSpec, analyze, cumulativeBpm, bgColorForLevel, fmtMMSS, breakSeconds } = mod.exports;

/* ---- load worker formula ---- */
const wsrc = readFileSync(here('../workers/src/worker.js'), 'utf8');
const wmatch = wsrc.match(/\/\* ---------------- level formula[\s\S]*?(?=\/\* ---------------- proof check)/);
if (!wmatch) { console.error('FATAL: worker formula section not found'); process.exit(1); }
const worker = new Function(wmatch[0] + '; return { specForLevel };')();

console.log('# game: reference math');
{
  const r = analyze([0, 250, 500, 750]);
  check('analyze bpm: 4 clicks in 750ms = 80 stream bpm', close(r.bpm, 80), String(r.bpm));
  check('analyze ur: perfect quarter intervals = UR 0', close(r.ur, 0), String(r.ur));
  check('analyze elapsed', close(r.elapsed, 750));
  const r2 = analyze([0, 100, 300]);
  check('analyze ur: stdev 50ms -> UR 500', close(r2.ur, 500), String(r2.ur));
  check('cumulativeBpm(4, 750) = 80', close(cumulativeBpm(4, 750), 80));
}

console.log('# game: level spec anchor points (from design comments)');
{
  const l79 = levelSpec(79), l80 = levelSpec(80), l90 = levelSpec(90), l230 = levelSpec(230);
  check('L79 = 169 bpm / 202 UR / 63 notes (ramp end, t=78/79)', l79.bpm === 169 && l79.ur === 202 && l79.notes === 63, JSON.stringify(l79));
  check('L80 = 170 bpm / 200 UR / 64 notes (smooth handoff)', l80.bpm === 170 && l80.ur === 200 && l80.notes === 64, JSON.stringify(l80));
  check('L90 = 180 bpm / 180 UR / 1024 notes', l90.bpm === 180 && l90.ur === 180 && l90.notes === 1024, JSON.stringify(l90));
  check('L230 = 327 bpm', l230.bpm === 327, JSON.stringify(l230));
  const l81 = levelSpec(81);
  check('L81 is a burst: 8 notes at 170*330/270', l81.burst && l81.notes === 8 && close(l81.bpm, 170 * 330 / 270), JSON.stringify(l81));
}

console.log('# game: formulas stay sane across the whole range');
{
  let sane = true, why = '';
  for (let L = 1; L <= 3000; L++) {
    const s = levelSpec(L);
    if (!Number.isFinite(s.bpm) || !Number.isFinite(s.ur) || !Number.isFinite(s.notes) ||
        s.bpm <= 0 || s.ur <= 0 || s.notes < 6 || s.notes > 10000) { sane = false; why = 'L=' + L; break; }
  }
  check('levelSpec(1..3000) finite & bounded', sane, why);
  check('bgColorForLevel(1) = soft green', JSON.stringify(bgColorForLevel(1)) === '{"r":123,"g":216,"b":143}');
  check('bgColorForLevel(500) = grey cap', JSON.stringify(bgColorForLevel(500)) === '{"r":169,"g":169,"b":169}');
  check('fmtMMSS(125) = 02:05', fmtMMSS(125) === '02:05');
  check('breakSeconds(120, 200) = 2', breakSeconds(120, 200) === 2);
  check('breakSeconds never below 1', breakSeconds(1, 999) === 1);
}

console.log('# anti-cheat: worker formula mirrors game formula exactly');
{
  let same = true, why = '';
  for (let L = 1; L <= 3000; L++) {
    const g = levelSpec(L), w = worker.specForLevel(L);
    if (!close(g.bpm, w.bpm) || !close(g.ur, w.ur) || g.notes !== w.notes || !!g.burst !== !!w.burst) {
      same = false; why = 'L=' + L + ' game=' + JSON.stringify(g) + ' worker=' + JSON.stringify(w); break;
    }
  }
  check('specForLevel == levelSpec for L 1..3000', same, why);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
