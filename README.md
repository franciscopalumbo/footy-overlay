# FootyOverlay

![License: FSAL-1.0](https://img.shields.io/badge/License-FSAL--1.0-blue.svg)
![Use: Non-Commercial](https://img.shields.io/badge/Use-Non--Commercial-red.svg)

> Live AFL Fantasy & SuperCoach scoring overlay — for web and Android TV.

A single-file SPA that sits over your AFL viewing experience and shows real-time fantasy scores for your tracked players. Deployed at **[footyoverlay.netlify.app](https://footyoverlay.netlify.app)**, and packageable as a native Android TV app via Capacitor.

---

## Table of Contents

1. [Quick Start (Local)](#1-quick-start-local)
2. [Netlify Deployment](#2-netlify-deployment)
3. [Mock Mode](#3-mock-mode)
4. [FanFooty Scraping — Implementation Guide](#4-fanfooty-scraping--implementation-guide)
5. [Capacitor — Android TV Build](#5-capacitor--android-tv-build)
6. [App Features](#6-app-features)
7. [File Structure](#7-file-structure)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Quick Start (Local)

No build step required.

```bash
# Clone the repo
git clone https://github.com/yourname/footyoverlay.git
cd footyoverlay

# Open directly in browser — works without a server
open index.html

# OR serve via any local server (recommended to enable function testing)
npx serve .
# Then visit: http://localhost:3000

# OR use the Netlify CLI for full local function support
npm install -g netlify-cli
netlify dev
# Then visit: http://localhost:8888
```

**First load:** You'll be prompted to create a profile (Netflix-style). Enter a name and pick an emoji. All data is stored in `localStorage` — nothing is sent to a server.

**Mock data:** Add `?mock=true` to any URL to run entirely on mock data. Recommended for development and demos.

---

## 2. Netlify Deployment

The app is already deployed at **[footyoverlay.netlify.app](https://footyoverlay.netlify.app)**.

To deploy your own fork:

### Option A — Deploy via Netlify Dashboard (recommended)

1. Push this repo to GitHub (or GitLab / Bitbucket).
2. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from Git**.
3. Select your repo.
4. **Build settings:**
   - Build command: *(leave blank)*
   - Publish directory: `.`
5. Click **Deploy site**.

That's it. The `netlify.toml` handles all redirect and function config automatically.

### Option B — Netlify CLI

```bash
npm install -g netlify-cli
netlify login
netlify init      # links to your Netlify account
netlify deploy    # preview deploy
netlify deploy --prod  # production deploy
```

### Environment Variables

Set these in **Netlify Dashboard → Site Settings → Environment Variables**:

| Variable          | Value    | Description                                      |
|-------------------|----------|--------------------------------------------------|
| `FANFOOTY_MOCK`   | `true`   | Return mock data instead of scraping FanFooty    |
| `FANFOOTY_MOCK`   | `false`  | Enable live scraping (once implemented)          |
| `NODE_VERSION`    | `18`     | Node.js runtime for serverless functions         |

> **During development:** Keep `FANFOOTY_MOCK=true` so you don't hammer FanFooty while building.

### Serverless Function Dependencies

Once you're ready to implement live scraping, install dependencies:

```bash
# In project root (Netlify bundles these automatically via esbuild)
npm init -y
npm install node-fetch cheerio
```

The function lives at: `netlify/functions/fanfooty-proxy.js`
It's accessible via: `GET /api/fanfooty-proxy` (redirected by `netlify.toml`)

---

## 3. Mock Mode

Append `?mock=true` to any URL to load the app with fully simulated data:

```
http://localhost:8888/?mock=true
https://footyoverlay.netlify.app/?mock=true
```

In mock mode:
- Live games are shown with realistic score data.
- Scores update every poll cycle (with random increments) to demonstrate flash animations.
- Toast notifications fire when tracked players "score".
- A yellow **MOCK DATA** badge appears in the header.
- No network requests are made to FanFooty.

The app also **auto-falls back to mock mode** if the Netlify function fails (e.g. FanFooty is unreachable or scraping breaks). A console warning is logged and the mock badge appears.

---

## 4. FanFooty Scraping — Implementation Guide

> The Netlify function (`netlify/functions/fanfooty-proxy.js`) is scaffolded with detailed comments. This section gives you the implementation roadmap.

### Overview

FanFooty (`fanfooty.com.au`) does not have a public API. We scrape their HTML server-side (in the Netlify function) to avoid CORS issues and to keep FanFooty's domain out of the browser.

### Key URLs

| Page                   | URL                                              | Purpose                     |
|------------------------|--------------------------------------------------|-----------------------------|
| Live scores            | `https://www.fanfooty.com.au/score/live/`        | Active game summaries        |
| Game detail            | `https://www.fanfooty.com.au/game/{id}/`         | Player-level stat table      |
| Round fixtures         | `https://www.fanfooty.com.au/fixture/`           | Upcoming game schedule       |

### What We Scrape

For each player in a live game, the proxy captures three fields from the game detail page:

| Field         | Description                        |
|---------------|------------------------------------|
| `number`      | Player's guernsey number           |
| `name`        | Player's full name                 |
| `score`       | Player's current fantasy score     |

This keeps the payload small and the scraping logic simple. The front-end uses these fields directly to display and track scores.

### Implementation Steps

**Step 1 — Inspect the live scores page**

Open `https://www.fanfooty.com.au/score/live/` in Chrome DevTools. Look for:
- A repeating container per game (e.g. `div.game-card`, `div.match`, `table.scores`)
- Team names, scores, quarter, time remaining, and venue
- A `data-game-id` attribute or similar identifier on each game element

Update the `parseLiveGames($)` function in `fanfooty-proxy.js` with the correct selectors.

**Step 2 — Inspect the game detail page**

Open a game detail URL. Look for a player stats table containing guernsey number, player name, and fantasy score columns.

Update `fetchGamePlayers(gameId)` to extract `number`, `name`, and `score` for each player row.

**Step 3 — Implement the fixture parser**

Inspect `https://www.fanfooty.com.au/fixture/` for upcoming games. Update `parseUpcomingGames($)`.

**Step 4 — Wire it all together**

In the main `handler` function, replace the mock placeholder block with:

```javascript
const response = await fetch('https://www.fanfooty.com.au/score/live/', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Referer': 'https://www.fanfooty.com.au/',
  },
});
const html = await response.text();
const $ = cheerio.load(html);

const liveGames = parseLiveGames($);
// For each live game, fetch player stats
for (const game of liveGames) {
  game.players = await fetchGamePlayers(game.id);
  // Each player: { number, name, score }
}

const upcomingGames = parseUpcomingGames($);
const round = parseCurrentRound($);

return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ round, liveGames, upcomingGames }),
};
```

### Rate Limiting & Politeness

- The front-end polls every **30 seconds** for live data, **5 minutes** for upcoming.
- Do not reduce below **15 seconds** — FanFooty may rate-limit or block your Netlify function IP.
- Netlify functions have a shared IP pool; if you get blocked, try adding a `X-Forwarded-For` spoofing header or contact FanFooty about API access.
- FanFooty's `robots.txt` should be reviewed before scraping in production.

### Alternative: FanFooty Has an API

If FanFooty releases an official API or JSON endpoint in future, update the handler to use it directly. The response shape expected by the front-end is documented at the top of `fanfooty-proxy.js`.

---

## 5. Capacitor — Android TV Build

### Prerequisites

```bash
node --version   # 18+ recommended
java --version   # Java 17 (for Android Gradle)
# Android Studio installed with SDK Platform 33+
# Android TV emulator or physical device
```

### Setup

```bash
# Install Capacitor CLI
npm install -g @capacitor/cli

# Install Capacitor Android
npm install @capacitor/core @capacitor/android

# Add Android platform
npx cap add android

# Sync web assets into the Android project
npx cap sync android
```

### Android TV Specific Configuration

After running `npx cap add android`, make these changes to `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- Replace the existing <uses-feature> and <intent-filter> blocks with: -->

<!-- Declare this as a Leanback (Android TV) app -->
<uses-feature android:name="android.software.leanback" android:required="false" />
<uses-feature android:name="android.hardware.touchscreen" android:required="false" />

<application
    android:banner="@drawable/banner"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    ...>

  <activity
      android:name=".MainActivity"
      android:exported="true">
    <intent-filter>
      <action android:name="android.intent.action.MAIN" />
      <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
    </intent-filter>
    <intent-filter>
      <action android:name="android.intent.action.MAIN" />
      <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
  </activity>
</application>
```

Also add a TV banner image (320×180px) at `android/app/src/main/res/drawable/banner.png`.

### Build & Run

```bash
# Open in Android Studio (recommended for TV emulator)
npx cap open android

# OR build APK directly
cd android
./gradlew assembleRelease
# APK output: android/app/build/outputs/apk/release/app-release.apk

# Install on connected TV device or emulator
adb install android/app/build/outputs/apk/release/app-release.apk
```

### D-pad Navigation Notes

The app is built with Android TV D-pad navigation in mind:
- All interactive elements have `tabindex="0"` set
- `:focus-visible` styles show a bright green outline (visible at 10-foot distance)
- Font sizes are minimum 24px body / 36px+ headings
- No hover-only interactions (all hover states are replicated for focus)
- The overlay can be minimised/closed via the D-pad when focused

### Pointing the App at Your Netlify URL

When running as a native app, API calls go to `localhost` by default. Update `capacitor.config.json` to point to your production Netlify URL:

```json
{
  "server": {
    "url": "https://footyoverlay.netlify.app",
    "cleartext": false
  }
}
```

Then run `npx cap sync android` again to apply.

---

## 6. App Features

| Feature | Description |
|---------|-------------|
| **Watch Tab** | Live, upcoming and recent AFL games for the current round |
| **Game Cards** | Live: shows score, quarter, time. Upcoming: date, time, venue |
| **Game Detail** | Matchup header, import opponent, customise tracked teams, begin overlay |
| **Customise Players** | Create up to 5 named colour-coded tracking teams from players in the game |
| **Full Scoreboard Mode** | Shows all players from both teams — disables toast notifications |
| **Live Overlay** | Fixed, draggable scoring panel with per-team tables |
| **Score Flash** | Green flash on score increase, red on decrease |
| **Toast Notifications** | Pop-up alerts for tracked player scoring actions |
| **Notification Sound** | Web Audio API beep on scoring events (no external sounds) |
| **Profile Selector** | Netflix-style multi-profile support, all data isolated per profile |
| **Settings** | Scoring system, overlay opacity/position, poll interval, notification controls |
| **Mock Mode** | `?mock=true` for dev/demo — no live data needed |

---

## 7. File Structure

```
footyoverlay/
├── index.html                    # Complete SPA — all views, CSS, JS
├── netlify.toml                  # Netlify config: redirects, headers, functions
├── capacitor.config.json         # Capacitor: Android TV packaging config
├── README.md                     # This file
├── package.json                  # (create with npm init) for function deps
├── netlify/
│   └── functions/
│       └── fanfooty-proxy.js     # Serverless CORS proxy + scraping scaffold
└── android/                      # Generated by `npx cap add android`
    └── ...
```

---

## 8. Troubleshooting

**The overlay doesn't show scores**
→ Make sure you've selected at least one custom team in "Customise Players" and clicked "Begin Overlay". The overlay requires a game to be selected first.

**Data isn't updating**
→ Check the browser console for fetch errors. If the Netlify function is unreachable, the app falls back to mock data automatically. Confirm `FANFOOTY_MOCK=false` in Netlify environment variables.

**Netlify function returns 502**
→ FanFooty may have changed their HTML structure. Inspect the live page and update the CSS selectors in `fanfooty-proxy.js`. Also check Netlify function logs in the dashboard.

**Android TV D-pad focus isn't visible**
→ The `:focus-visible` outline is set to `3px solid #00ff88`. If your TV WebView strips it, add `outline-style: solid !important` to the CSS or increase `outline-width`.

**Capacitor sync fails**
→ Ensure `webDir` in `capacitor.config.json` is `"."` and that `index.html` exists in the project root. Run `npx cap sync android --deployment`.

**localStorage is full**
→ Navigate to Settings → **Clear All Data** to wipe all profiles and start fresh. Each profile's data is small (< 10KB), so this is unlikely unless you're storing very large team imports.

**Profiles are gone after update**
→ All data is stored in `localStorage` under the key prefix `footyoverlay_v1`. Clearing browser data or using private/incognito mode will lose profiles. This is expected behaviour for a client-side-only app.

---

## Contributing

PRs welcome. Key areas that need work:
- `fanfooty-proxy.js` — implement the actual HTML scraping once you've inspected FanFooty's live DOM
- Better position parsing for player imports (AFL Fantasy / SuperCoach URL import)
- Push notifications via Web Push API for mobile overlays

---

*FootyOverlay is an unofficial fan tool and is not affiliated with the AFL, AFL Fantasy, SuperCoach, or FanFooty.*
