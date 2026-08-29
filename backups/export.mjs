/* Leaderboard backup export - pulls the full public leaderboard + stats and
   writes a timestamped JSON snapshot into backups/. No auth needed (public API).
   Run: node backups/export.mjs */
import { writeFileSync, mkdirSync } from 'node:fs';
const BASE = 'https://osu-stamina-improver.pages.dev';
const lb = await (await fetch(BASE + '/api/leaderboard?limit=100')).json();
const stats = await (await fetch(BASE + '/api/stats')).json();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync('backups', { recursive: true });
const file = `backups/leaderboard-${stamp}.json`;
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), source: BASE, players: lb.leaderboard, stats }, null, 2));
console.log('wrote ' + file + ' (' + lb.leaderboard.length + ' players, best level ' + stats.bestLevel + ', ' + stats.totalTaps + ' taps)');
