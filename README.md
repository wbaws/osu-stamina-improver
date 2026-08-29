# osu! Stamina Improver

A browser-based stamina / stream-speed trainer for osu! players, with a **global leaderboard**.

Based on the [osu! Stream Speed Benchmark](https://github.com/ckrisirkc/osuStreamSpeed.js) by arctic, rewritten by Yepstare.

## Play

**Play online: https://<YOUR_USERNAME>.github.io/osu-stamina-improver/** — no install, no account, works in any modern browser.

You can also download this repository and open `index.html` directly.

## How it works

- **Levels 1–79**: lenient ramp — 100 bpm / 350 UR / 6 notes up to 170 bpm / 200 UR / 64 notes.
- **Levels 80+**: 10-level cycles. Even positions are **stamina** levels (bpm climbs 2 per level, note counts grow to thousands); odd positions are **BURST** levels (8 notes at ~1.22x the surrounding bpm).
- A level is cleared when your **stream speed** (osu! 1/4-note formula) reaches the target **and** your **unstable rate** (10 × stdev of inter-click intervals) stays under the cap.
- **Test Me** runs 3 benchmarks at your own pace and places you at the right level.
- Custom keys (default Z/X), optional metronome with real osu! hit sounds, optional mouse/touch tapping, breaks between levels.

Your local progress is saved in your browser (localStorage). Nothing is tracked unless you submit to the leaderboard.

## Global leaderboard

Clear any level → pick a display name → your score lands on the public leaderboard shown on the page:

- **ranked by highest level cleared**, plus bpm, UR, total taps and plays
- **global stats**: total players, best level worldwide, total taps logged, average top bpm, level distribution
- **anti-cheat**: submissions include the raw click-timing; the server recomputes bpm/UR with the exact same level formula and rejects anything inconsistent (forged or physically impossible scores fail)

The leaderboard API is a free **Cloudflare Worker** (workers KV). The game itself is static — no servers needed to play.

### Self-hosting the leaderboard worker (optional)

```bash
cd workers
npm install
npx wrangler kv namespace create LEADERBOARD   # paste the id into wrangler.toml
npx wrangler deploy
```

Then set your worker URL as `OSI_API_BASE` in `index.html` and redeploy.

## Development

Pure static site — edit `index.html`, refresh. The pure game logic (level formula, bpm/UR math) is DOM-free and unit-testable in Node:

```bash
node tests/verify.mjs
```

## Credits & license

- Based on osu! Stream Speed Benchmark by **arctic** (MIT)
- Charts by [CanvasJS](https://canvasjs.com/)
- osu! is a registered trademark of ppy Pty Ltd. This project is not affiliated with or endorsed by ppy.

MIT — see [LICENSE](LICENSE).
