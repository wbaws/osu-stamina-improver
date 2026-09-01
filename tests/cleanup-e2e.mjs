import { execSync } from 'node:child_process';
/* Cleanup for AutoCoder e2e test entries ONLY.
   Pattern-locked: matches e2e-* and nobody-e2e-* keys (and legacy lb:e2e-* from the KV era).
   NEVER touches real player rows. Run from the workers/ directory:
     node tests/cleanup-e2e.mjs
*/
const cmd = "DELETE FROM players WHERE key LIKE 'e2e-%' OR key LIKE 'nobody-e2e-%' OR key LIKE 'lb:e2e-%'";
try {
  const out = execSync('npx wrangler d1 execute osi-leaderboard --remote --command "' + cmd + '" -y', { stdio: 'pipe', encoding: 'utf8' });
  console.log('cleanup executed');
  const check = execSync('npx wrangler d1 execute osi-leaderboard --remote --command "SELECT COUNT(*) AS remaining FROM players WHERE key LIKE \'%e2e%\'" --json', { stdio: 'pipe', encoding: 'utf8' });
  const start = check.indexOf('{');
  const end = check.lastIndexOf('}');
  const j = JSON.parse(check.slice(start, end + 1));
  console.log('remaining e2e rows: ' + (j.result && j.result[0] ? j.result[0].remaining : '?'));
} catch (e) {
  console.error('cleanup failed: ' + (e.stderr || e.message));
  process.exit(1);
}
