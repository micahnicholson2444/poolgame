# Reds & Yellows — 8-Ball Pool

A browser pool game with three modes from the main menu:

- **Play** — creates a table and gives you a short code to share.
- **Join** — enter a friend's code to connect to their table.
- **Sandbox** — practice solo; it's always your turn.

Online play uses [PeerJS](https://peerjs.com/) for a direct peer-to-peer
connection between browsers (via its free public signalling server), so
there's no backend to host — this works as a plain static site, including
on GitHub Pages.

## Rules implemented

- Whoever breaks pots only reds → they're on reds (opponent yellows); only
  yellows → they're on yellows; both, or neither → the table stays **open**.
- A foul (hitting the wrong colour first, potting the cue ball, or hitting
  nothing) hands the other player two shots, and the first of those two is
  a free ball (any colour is a legal first hit).
- Potting one of your own colour earns an extra shot.
- Potting the black before clearing your colour loses the game.
- Potting the black together with the cue ball loses the game — even if
  you were on the black.

## Running locally

Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed address in your browser. Opening `index.html`
directly (via `file://`) also works for Sandbox mode, but some browsers
restrict cross-origin scripts on `file://`, so a local server is safer for
testing online play.

## Deploying to GitHub Pages

1. Push the project files, including `manifest.webmanifest`, `service-worker.js` and the app icons, to a repository.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", choose **Deploy from a branch**, pick your
   default branch and the `/ (root)` folder, then save.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/` — that's
   your game link. Share it with a friend and use Play/Join to start a table.

## Installing on a phone

The game is an installable web app. Publish it over HTTPS first; opening the
HTML file directly from storage does not support app installation.

- **iPhone/iPad:** open the HTTPS game link in Safari, tap **Share**, then
  **Add to Home Screen**.
- **Android:** open the HTTPS game link in Chrome and choose **Install app**
  from the browser menu (or use the install prompt if it appears).

It launches in a standalone window and caches the game files for offline
launch. Online multiplayer still needs an internet connection. iOS may ignore
the landscape preference, but the game asks players to rotate before play.

## Notes & possible tweaks

- Both players must have the page open at the same time for Play/Join —
  there's no persistence between sessions.
- The host (the player who clicked "Play") always breaks first each rack.
- Ball physics, table size, power and friction are all tunable constants
  near the top of `game.js` if you want a faster or slower table.
