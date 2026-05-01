/**
 * FootyOverlay — FanFooty Proxy Netlify Function
 * File: /netlify/functions/fanfooty-proxy.js
 *
 * DEPENDENCIES:
 *   npm install node-fetch@2 cheerio
 *   (node-fetch v2 is required — v3 is ESM-only and won't load via require())
 *
 * ENVIRONMENT VARIABLES:
 *   FANFOOTY_LIVE=true   — perform real scraping. Anything else (or unset)
 *                          serves MOCK_RESPONSE. Default-off is intentional:
 *                          local dev and accidentally-deployed previews
 *                          should never hammer FanFooty.
 *
 * ENDPOINT (via netlify.toml redirect):
 *   GET /api/fanfooty-proxy
 *
 * RESPONSE SHAPE (top-level keys are guaranteed to exist; values may be []):
 *   {
 *     round:         number,
 *     liveGames:     Game[],   // games kicked off within the last ~3.5h with scores
 *     upcomingGames: Game[],   // games whose kickoff is still in the future
 *     pastGames:     Game[],   // games kicked off >3.5h ago with scores
 *     _fallback:     boolean,  // optional: true when mock served due to error
 *     _error:        string,   // optional: error summary when _fallback=true
 *   }
 *
 * ─────────────────────────────────────────────────────────────
 * ARCHITECTURE — LAYER 1 (HTML scraping only):
 *
 *   (A) /game/roundscores.php — server-rendered. Source for current-round
 *       per-player DT (AFL Fantasy) and SC (SuperCoach) scores. NO raw stat
 *       counts (kicks/handballs/marks/etc), NO quarter/time, NO jersey/pos.
 *       Those fields are populated as null and the frontend renders "—".
 *
 *   (B) /game/fixture.php — server-rendered. Source for venue, kickoff date
 *       and time, and round number for upcoming and past games. Also used
 *       to classify scored games as 'live' vs 'final' by comparing kickoff
 *       to current Melbourne local time.
 *
 *   (C) / (homepage) — server-rendered. Source for canonical /live/ URLs
 *       (used as `liveUrl` on each game) and team abbreviations as they
 *       appear in FanFooty's own short-form (COL, HAW, WBD, etc).
 *
 *   The JS-rendered matchcentre at /live/{year}/{id}-{slug}.html is NOT
 *   scraped — Cheerio cannot see its data. Layer 2 will replace this when
 *   we discover the underlying JSON polling endpoint.
 *
 * ─────────────────────────────────────────────────────────────
 * RESILIENCE STRATEGY:
 *   · Every selector is wrapped in try/catch. Failed game/player rows are
 *     skipped without aborting.
 *   · Top-level fetch failures fall back to MOCK_RESPONSE so the frontend
 *     always receives a valid payload.
 *   · 30-second module-scoped cache prevents pounding FanFooty when
 *     multiple users (or the polling client) hit the function in quick
 *     succession on a warm container.
 *   · 9-second fetch timeout leaves headroom under Netlify's 10s limit.
 * ─────────────────────────────────────────────────────────────
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URL         = 'https://www.fanfooty.com.au';
const FETCH_TIMEOUT_MS = 9000; // Netlify hard limit is 10s; leave 1s headroom
const CACHE_TTL_MS     = 30 * 1000; // 30 seconds

/**
 * Window (in milliseconds) after kickoff during which a scored game is
 * considered "live" rather than "final". AFL games run ~2h with breaks;
 * 3.5h covers stoppages, overtime, and the post-siren window where the
 * game still feels live to viewers.
 */
const LIVE_WINDOW_MS = 3.5 * 60 * 60 * 1000;

/**
 * Browser-like request headers. Identifies us politely while still looking
 * like a real client — FanFooty serves different markup to obvious bots.
 */
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (FootyOverlay/1.0; +https://github.com/franciscopalumbo/footy-overlay) Chrome/124.0.0.0',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer':         'https://www.fanfooty.com.au/',
};

// ─── TEAM METADATA ────────────────────────────────────────────────────────────

/**
 * Canonical team registry. Each entry maps a club to:
 *   key      — internal canonical key (lowercase, no spaces)
 *   names    — list of strings FanFooty might use (roundscores, fixture, homepage)
 *   abbr     — short code displayed in the UI
 *   color    — left-border accent in the frontend's game cards
 *
 * Keep this comprehensive. parseTeamName() does case-insensitive matching
 * across all `names` entries so variations like "North Melbourne",
 * "Kangaroos", and "NM" all resolve to the same canonical record.
 */
const TEAMS = [
  { key: 'adelaide',     names: ['Adelaide', 'Adelaide Crows', 'Crows', 'ADE'],          abbr: 'ADE',  color: '#002b5c' },
  { key: 'brisbane',     names: ['Brisbane', 'Brisbane Lions', 'Lions', 'BRI', 'BL'],    abbr: 'BRI',  color: '#a30046' },
  { key: 'carlton',      names: ['Carlton', 'Carlton Blues', 'Blues', 'CAR'],            abbr: 'CAR',  color: '#003087' },
  { key: 'collingwood',  names: ['Collingwood', 'Magpies', 'COL'],                       abbr: 'COL',  color: '#1a1a1a' },
  { key: 'essendon',     names: ['Essendon', 'Bombers', 'ESS'],                          abbr: 'ESS',  color: '#cc2200' },
  { key: 'fremantle',    names: ['Fremantle', 'Dockers', 'FRE'],                         abbr: 'FRE',  color: '#2a0845' },
  { key: 'geelong',      names: ['Geelong', 'Cats', 'GEE'],                              abbr: 'GEE',  color: '#1c3f6e' },
  { key: 'goldcoast',    names: ['Gold Coast', 'Suns', 'GC'],                            abbr: 'GC',   color: '#e8281a' },
  { key: 'gws',          names: ['GWS', 'Greater Western Sydney', 'GWS Giants', 'Giants', 'Western Sydney'], abbr: 'GWS', color: '#f47920' },
  { key: 'hawthorn',     names: ['Hawthorn', 'Hawks', 'HAW'],                            abbr: 'HAW',  color: '#4d2004' },
  { key: 'melbourne',    names: ['Melbourne', 'Demons', 'MEL'],                          abbr: 'MEL',  color: '#0f1b56' },
  { key: 'northmelbourne', names: ['North Melbourne', 'Kangaroos', 'NM', 'North'],       abbr: 'NM',   color: '#003087' },
  { key: 'portadelaide', names: ['Port Adelaide', 'Power', 'PTA', 'PA', 'Port'],         abbr: 'PTA',  color: '#009fd9' },
  { key: 'richmond',     names: ['Richmond', 'Tigers', 'RIC', 'RI'],                     abbr: 'RIC',  color: '#ffd700' },
  { key: 'stkilda',      names: ['St Kilda', 'Saints', 'STK'],                           abbr: 'STK',  color: '#ed0f05' },
  { key: 'sydney',       names: ['Sydney', 'Sydney Swans', 'Swans', 'SYD'],              abbr: 'SYD',  color: '#ed0f05' },
  { key: 'westcoast',    names: ['West Coast', 'West Coast Eagles', 'Eagles', 'WCE', 'WC'], abbr: 'WCE', color: '#003087' },
  { key: 'westernbulldogs', names: ['Western Bulldogs', 'Bulldogs', 'WBD', 'WB'],        abbr: 'WBD',  color: '#003087' },
];

// ─── MOCK RESPONSE ────────────────────────────────────────────────────────────

const MOCK_RESPONSE = {
  round: 14,
  liveGames: [
    {
      id: 'mock_g001', fanfootyId: null, liveUrl: null,
      teamA: { name: 'Richmond',    abbr: 'RIC',  color: '#ffd700', score: 72, goals: 10, behinds: 12 },
      teamB: { name: 'Collingwood', abbr: 'COL',  color: '#1a1a1a', score: 61, goals: 8,  behinds: 13 },
      quarter: 3, timeRemaining: '8:42', venue: 'MCG',
      date: 'Sat 22 Jun', time: '7:25 PM AET',
      status: 'live',
      players: [
        mockPlayer('dustin-martin',    'Dustin Martin',    'MID', 88,  91),
        mockPlayer('shai-bolton',      'Shai Bolton',      'FWD', 54,  49),
        mockPlayer('jack-riewoldt',    'Jack Riewoldt',    'FWD', 62,  68),
        mockPlayer('scott-pendlebury', 'Scott Pendlebury', 'MID', 102, 109),
        mockPlayer('nick-daicos',      'Nick Daicos',      'MID', 118, 124),
        mockPlayer('jordan-de-goey',   'Jordan De Goey',   'FWD', 76,  72),
      ],
    },
    {
      id: 'mock_g002', fanfootyId: null, liveUrl: null,
      teamA: { name: 'Carlton',  abbr: 'CAR', color: '#003087', score: 45, goals: 6, behinds: 9  },
      teamB: { name: 'Hawthorn', abbr: 'HAW', color: '#4d2004', score: 55, goals: 7, behinds: 14 },
      quarter: 2, timeRemaining: '14:21', venue: 'Marvel Stadium',
      date: 'Sat 22 Jun', time: '4:35 PM AET',
      status: 'live',
      players: [
        mockPlayer('patrick-cripps', 'Patrick Cripps', 'MID', 95, 101),
        mockPlayer('sam-walsh',      'Sam Walsh',      'MID', 67, 63),
        mockPlayer('james-sicily',   'James Sicily',   'DEF', 74, 79),
        mockPlayer('jai-newcombe',   'Jai Newcombe',   'MID', 83, 88),
      ],
    },
  ],
  upcomingGames: [
    {
      id: 'mock_g003', fanfootyId: null, liveUrl: null,
      round: 14,
      teamA: { name: 'Geelong',  abbr: 'GEE', color: '#1c3f6e', score: 0, goals: 0, behinds: 0 },
      teamB: { name: 'Brisbane', abbr: 'BRI', color: '#a30046', score: 0, goals: 0, behinds: 0 },
      quarter: 0, timeRemaining: '', venue: 'GMHBA Stadium',
      date: 'Sat 22 Jun', time: '7:25 PM AET',
      status: 'upcoming',
      players: [],
    },
    {
      id: 'mock_g004', fanfootyId: null, liveUrl: null,
      round: 14,
      teamA: { name: 'Essendon', abbr: 'ESS', color: '#cc2200', score: 0, goals: 0, behinds: 0 },
      teamB: { name: 'GWS',      abbr: 'GWS', color: '#f47920', score: 0, goals: 0, behinds: 0 },
      quarter: 0, timeRemaining: '', venue: 'Marvel Stadium',
      date: 'Sun 23 Jun', time: '12:35 PM AET',
      status: 'upcoming',
      players: [],
    },
  ],
  pastGames: [
    {
      id: 'mock_g005', fanfootyId: null, liveUrl: null,
      teamA: { name: 'Melbourne',   abbr: 'MEL', color: '#0f1b56', score: 96,  goals: 14, behinds: 12 },
      teamB: { name: 'Sydney',      abbr: 'SYD', color: '#ed0f05', score: 102, goals: 15, behinds: 12 },
      quarter: 4, timeRemaining: '0:00', venue: 'MCG',
      date: 'Fri 21 Jun', time: '7:50 PM AET',
      status: 'final',
      players: [
        mockPlayer('clayton-oliver', 'Clayton Oliver', 'MID', 134, 142),
        mockPlayer('isaac-heeney',   'Isaac Heeney',   'MID', 121, 128),
      ],
    },
  ],
};

function mockPlayer(id, name, pos, dt, sc) {
  return {
    id, jersey: null, name, pos,
    score: dt, scoreDT: dt, scoreSC: sc,
    stats: emptyStats(),
  };
}

/**
 * Empty stats object. The frontend reads these keys; emit them all as null
 * so it can render "—" placeholders without defensive checks.
 */
function emptyStats() {
  return {
    kk: null, hb: null, mk: null, tk: null, ho: null, fk: null,
    gb: null, mg: null, cp: null, cl: null,
    effPct: null, togPct: null,
  };
}

// ─── MODULE-SCOPED CACHE ──────────────────────────────────────────────────────

/**
 * Module-scoped cache. Persists across warm invocations of the same Netlify
 * function container. Cold-start invocations get a fresh empty cache, which
 * is fine — first request after a cold start triggers exactly one scrape,
 * then subsequent requests within 30s reuse the result.
 *
 * Concurrent callers within the TTL window each get the same cached object;
 * we don't lock because the worst-case is a handful of duplicate fetches
 * during cache-miss bursts and FanFooty can absorb that.
 */
let cache = { data: null, expiresAt: 0 };

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: jsonHeaders(),
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── Mock mode (default) — only scrape when FANFOOTY_LIVE === 'true' ──────
  if (process.env.FANFOOTY_LIVE !== 'true') {
    console.log('[fanfooty-proxy] FANFOOTY_LIVE!=true — returning mock data');
    return ok(MOCK_RESPONSE);
  }

  // ── Cache check ──────────────────────────────────────────────────────────
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    const ageMs = CACHE_TTL_MS - (cache.expiresAt - now);
    console.log(`[fanfooty-proxy] cache HIT (age ${Math.round(ageMs / 1000)}s)`);
    return ok(cache.data);
  }

  // ── Live scrape ──────────────────────────────────────────────────────────
  try {
    const [roundScoresHtml, fixtureHtml, homepageHtml] = await Promise.all([
      fetchPage(`${BASE_URL}/game/roundscores.php`),
      fetchPage(`${BASE_URL}/game/fixture.php`),
      fetchPage(`${BASE_URL}/`),
    ]);

    const $scores   = cheerio.load(roundScoresHtml);
    const $fixture  = cheerio.load(fixtureHtml);
    const $home     = cheerio.load(homepageHtml);

    // Build a lookup from the homepage of canonical /live/ URLs and team
    // abbreviations as FanFooty displays them, keyed by team-pair.
    const homepageGames = parseHomepageGames($home);

    // Roundscores gives us players + scores for every game in this round
    // that has been played or is in progress.
    const { round, scoredGames } = parseRoundScores($scores, homepageGames);

    // Fixture gives us venue, kickoff datetime, and the same-round games
    // that haven't started yet.
    const { upcomingGames, kickoffByPair } = parseFixture(
      $fixture, round, scoredGames, homepageGames,
    );

    // Classify scored games into live vs past using kickoff time.
    const { liveGames, pastGames } = classifyScoredGames(
      scoredGames, kickoffByPair, new Date(),
    );

    const payload = { round, liveGames, upcomingGames, pastGames };

    // Cache and return
    cache = { data: payload, expiresAt: now + CACHE_TTL_MS };
    console.log(
      `[fanfooty-proxy] OK — R${round}: ` +
      `${liveGames.length} live, ${upcomingGames.length} upcoming, ${pastGames.length} past`,
    );
    return ok(payload);

  } catch (err) {
    console.error('[fanfooty-proxy] Fatal scrape error:', err.message);
    // Always return 200 with mock data so the frontend stays functional
    return ok({ ...MOCK_RESPONSE, _fallback: true, _error: err.message });
  }
};

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function jsonHeaders() {
  return {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache, no-store',
  };
}

function ok(payload) {
  return { statusCode: 200, headers: jsonHeaders(), body: JSON.stringify(payload) };
}

// ─── HOMEPAGE PARSER ──────────────────────────────────────────────────────────

/**
 * Parse the homepage's fixture list to extract canonical /live/ URLs and
 * the abbreviation pairs (e.g. "COL" / "HAW") that FanFooty itself uses.
 *
 * Returns a Map keyed by canonical pair-key (alphabetical) → metadata.
 * Used downstream to:
 *   · prefer FanFooty's short codes over our derived ones for UI consistency
 *   · provide a verified `liveUrl` rather than constructing a fragile guess
 */
function parseHomepageGames($) {
  const games = new Map();

  // The fixture is rendered as a list of <a> elements pointing at /live/...
  // Each link's text contains team abbreviations and (when finalised) scores.
  $('a[href*="/live/"]').each((_, el) => {
    try {
      const $a   = $(el);
      const href = $a.attr('href') || '';

      // Match: /live/2026/9764-magpies-hawks.html  →  id=9764, slug=magpies-hawks
      const m = href.match(/\/live\/(\d{4})\/(\d+)-([a-z0-9-]+)\.html/i);
      if (!m) return;

      const liveUrl    = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const fanfootyId = parseInt(m[2], 10);

      // Extract the two abbreviations from the link text. Format is loose:
      //   "Thu 30 Apr, 7.30  COL HAW  93 93"
      // Capture two consecutive uppercase 2-3 letter tokens.
      const text = $a.text().replace(/\s+/g, ' ').trim();
      const abbrMatch = text.match(/\b([A-Z]{2,4})\b\s+\b([A-Z]{2,4})\b/);
      if (!abbrMatch) return;

      const abbrA = abbrMatch[1];
      const abbrB = abbrMatch[2];

      const teamA = findTeamByAnyName(abbrA);
      const teamB = findTeamByAnyName(abbrB);
      if (!teamA || !teamB) return;

      games.set(pairKey(teamA.key, teamB.key), {
        fanfootyId,
        liveUrl,
        teamA: teamA,
        teamB: teamB,
      });
    } catch (e) {
      // Ignore individual link failures — homepage layout is decorative
      // and we treat its data as a nice-to-have, not a requirement.
    }
  });

  return games;
}

// ─── ROUND SCORES PARSER ──────────────────────────────────────────────────────

/**
 * Parse /game/roundscores.php. Returns the round number and one entry per
 * scored game (live OR final — classification happens later using kickoff
 * times from the fixture page).
 *
 * @param {CheerioAPI} $
 * @param {Map} homepageGames - from parseHomepageGames(); used to enrich
 *                              each game with fanfootyId and liveUrl.
 * @returns {{ round: number, scoredGames: Game[] }}
 */
function parseRoundScores($, homepageGames) {
  // ── 1. Round number ──────────────────────────────────────────────────────
  let round = 0;
  const titleMatch = $('title').text().match(/Round\s+(\d+)/i);
  if (titleMatch) {
    round = parseInt(titleMatch[1], 10);
  } else {
    // Fallback: scan body text for "Round N"
    const bodyMatch = $('body').text().match(/Round\s+(\d+)/i);
    if (bodyMatch) round = parseInt(bodyMatch[1], 10);
  }

  // ── 2. Find team header cells ────────────────────────────────────────────
  // A team header is a <td> with NO <a> children whose text matches
  //   "TeamName: G.B" or "TeamName: G.B.Total"
  const teamHeaderCells = [];
  $('td').each((_, el) => {
    const $el = $(el);
    if ($el.find('a').length > 0) return;
    const text = $el.text().trim();
    if (/^[A-Za-z][A-Za-z .]+:\s*\d+\.\d+(\.\d+)?$/.test(text)) {
      teamHeaderCells.push({ el, text });
    }
  });

  // ── 3. Pair adjacent headers into games ──────────────────────────────────
  const scoredGames = [];
  for (let i = 0; i + 1 < teamHeaderCells.length; i += 2) {
    try {
      const teamAMeta = parseTeamHeader(teamHeaderCells[i].text);
      const teamBMeta = parseTeamHeader(teamHeaderCells[i + 1].text);
      if (!teamAMeta || !teamBMeta) continue;

      // Boundary for player collection is the next team's header cell
      const stopForA = teamHeaderCells[i + 1].el;
      const stopForB = teamHeaderCells[i + 2] ? teamHeaderCells[i + 2].el : null;

      const teamAPlayers = collectPlayerRows($, teamHeaderCells[i].el, stopForA);
      const teamBPlayers = collectPlayerRows($, teamHeaderCells[i + 1].el, stopForB);

      // Cross-reference homepage to recover fanfootyId and liveUrl
      const key = pairKey(teamAMeta.key, teamBMeta.key);
      const homepageHit = homepageGames.get(key);

      const gameId = homepageHit
        ? `ff_${homepageHit.fanfootyId}`
        : `rs_${round}_${i / 2}`;

      scoredGames.push({
        id:         gameId,
        fanfootyId: homepageHit ? homepageHit.fanfootyId : null,
        liveUrl:    homepageHit ? homepageHit.liveUrl    : null,
        teamA: {
          name:    teamAMeta.canonical.names[0],
          abbr:    teamAMeta.canonical.abbr,
          color:   teamAMeta.canonical.color,
          score:   teamAMeta.score,
          goals:   teamAMeta.goals,
          behinds: teamAMeta.behinds,
          _key:    teamAMeta.key, // internal — used for fixture matching
        },
        teamB: {
          name:    teamBMeta.canonical.names[0],
          abbr:    teamBMeta.canonical.abbr,
          color:   teamBMeta.canonical.color,
          score:   teamBMeta.score,
          goals:   teamBMeta.goals,
          behinds: teamBMeta.behinds,
          _key:    teamBMeta.key,
        },
        // Quarter/time/venue come from the matchcentre or fixture; we don't
        // have them at this point. classifyScoredGames may fill venue from
        // the fixture later. Quarter and timeRemaining stay null.
        quarter:       null,
        timeRemaining: null,
        venue:         null,
        date:          null,
        time:          null,
        status:        'live', // tentative — refined by classifyScoredGames
        players:       [...teamAPlayers, ...teamBPlayers],
      });
    } catch (e) {
      console.warn(`[parseRoundScores] Skipped game pair ${i}: ${e.message}`);
    }
  }

  return { round, scoredGames };
}

/**
 * Parse a team header cell's text.
 *
 * Examples:
 *   "Brisbane: 17.17.119"       → goals=17, behinds=17, score=119
 *   "North Melbourne: 14.12.96" → goals=14, behinds=12, score=96
 *   "Collingwood: 10.5"         → goals=10, behinds=5, score=65 (computed)
 *
 * Returns null if the team name doesn't resolve to a known club.
 */
function parseTeamHeader(text) {
  const match = text.match(/^(.+?):\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const rawName  = match[1].trim();
  const goals    = parseInt(match[2], 10) || 0;
  const behinds  = parseInt(match[3], 10) || 0;
  const score    = match[4] !== undefined
    ? parseInt(match[4], 10)
    : (goals * 6 + behinds);

  const canonical = findTeamByAnyName(rawName);
  if (!canonical) {
    console.warn(`[parseTeamHeader] Unknown team: "${rawName}"`);
    return null;
  }

  return { key: canonical.key, canonical, score, goals, behinds };
}

/**
 * Walk the <tr> siblings after a team header cell and collect player rows.
 */
function collectPlayerRows($, headerCell, stopBoundaryCell) {
  const players = [];
  const stopRow = stopBoundaryCell ? $(stopBoundaryCell).closest('tr') : null;

  let currentRow = $(headerCell).closest('tr').next();
  let guard = 0;
  const MAX_ROWS = 60;

  while (currentRow.length && guard++ < MAX_ROWS) {
    if (stopRow && currentRow.is(stopRow)) break;

    const cells = currentRow.find('td');
    if (!cells.length) {
      currentRow = currentRow.next();
      continue;
    }

    const firstCell  = $(cells[0]);
    const playerLink = firstCell.find('a[href*="/player/"]');

    if (playerLink.length > 0) {
      try {
        const name = playerLink.text().trim();
        const href = playerLink.attr('href') || '';
        // /player/will-ashcroft → will-ashcroft
        const slug = href.replace(/^.*\/player\//, '').replace(/\/$/, '');
        const dt   = parseInt($(cells[1]).text().trim(), 10);
        const sc   = parseInt($(cells[2]).text().trim(), 10);

        if (name && !Number.isNaN(dt) && !Number.isNaN(sc)) {
          players.push({
            id:      slug || `player_${players.length}`,
            jersey:  null, // not on roundscores.php
            name,
            pos:     null, // not on roundscores.php
            score:   dt,   // frontend toggles between scoreDT and scoreSC
            scoreDT: dt,
            scoreSC: sc,
            stats:   emptyStats(), // raw stats only on JS-rendered matchcentre
          });
        }
      } catch (e) {
        // Malformed row — skip silently
      }
    } else {
      // Non-player row: column header, separator, or start of next team.
      const rowText = currentRow.text().replace(/\s+/g, ' ').trim();
      if (/^[A-Za-z][A-Za-z .]+:\s*\d+\.\d+/.test(rowText)) break;
    }

    currentRow = currentRow.next();
  }

  return players;
}

// ─── FIXTURE PARSER ───────────────────────────────────────────────────────────

/**
 * Parse /game/fixture.php for upcoming games and kickoff datetimes.
 *
 * Returns:
 *   upcomingGames  — games in the current round whose kickoff is in the
 *                    future (Melbourne local time) AND whose team-pair is
 *                    NOT in scoredGames.
 *   kickoffByPair  — Map<pairKey, { kickoffMs, venue, date, time }>
 *                    for ALL fixture rows in the current round, used to
 *                    classify scored games as live vs final.
 */
function parseFixture($, currentRound, scoredGames, homepageGames) {
  const upcomingGames = [];
  const kickoffByPair = new Map();
  const scoredKeys    = new Set(scoredGames.map(g => pairKey(g.teamA._key, g.teamB._key)));
  const nowMs         = Date.now();

  let fixtureRound = 0;
  let lastDate     = ''; // some rows omit the date when same as the row above
  let gameCounter  = 0;

  $('table tr').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (!cells.length) return;

    const firstText = $(cells[0]).text().trim();

    // Round header detection
    const roundMatch = firstText.match(/^Round\s+(\d+)/i);
    if (roundMatch) {
      fixtureRound = parseInt(roundMatch[1], 10);
      lastDate = '';
      return;
    }

    // Only process the current round (Layer 1 doesn't show next-round
    // upcoming until current round finishes — keeps the UI focused).
    if (fixtureRound !== currentRound) return;

    // Find the cell containing " vs "
    let vsIdx = -1;
    cells.each((idx, cell) => {
      if ($(cell).text().includes(' vs ')) { vsIdx = idx; return false; }
    });
    if (vsIdx === -1) return;

    try {
      const opponentsText = $(cells[vsIdx]).text().trim();
      const vsParts = opponentsText.split(/\s+vs\s+/);
      if (vsParts.length < 2) return;

      const teamA = findTeamByAnyName(vsParts[0].trim());
      const teamB = findTeamByAnyName(vsParts[1].trim());
      if (!teamA || !teamB) return;

      // Date/venue/time extraction — column layout varies:
      //   [Day] [Date] [Opponents] [Ground] [Time]
      // or  [Date]      [Opponents] [Ground] [Time]   (if Day omitted)
      // The Day cell, when present, is alphabetic (e.g. "Saturday").
      let dateText  = '';
      const dayCell = vsIdx >= 2 ? $(cells[vsIdx - 2]).text().trim() : '';
      const dateCell = vsIdx >= 1 ? $(cells[vsIdx - 1]).text().trim() : '';

      if (dayCell && dateCell) {
        dateText = `${dayCell} ${dateCell}`.trim();
      } else if (dateCell) {
        dateText = dateCell;
      }

      // Some rows inherit the date from the previous row (collapsed cells)
      if (!dateText) dateText = lastDate;
      else lastDate = dateText;

      const venue = cells.length > vsIdx + 1 ? $(cells[vsIdx + 1]).text().trim() : '';
      const time  = cells.length > vsIdx + 2 ? $(cells[vsIdx + 2]).text().trim() : '';

      // Best-effort kickoff Date in Melbourne time. Returns null if we
      // can't parse — that game will fall through to default classification
      // (assumed live if it has scores, upcoming if not).
      const kickoffMs = parseKickoffMs(dateText, time, fixtureRound);

      const key = pairKey(teamA.key, teamB.key);
      kickoffByPair.set(key, { kickoffMs, venue, date: dateText, time });

      // Only include in upcomingGames if NOT already scored AND kickoff is
      // in the future (or unknown but no scores yet).
      if (scoredKeys.has(key)) return;
      if (kickoffMs !== null && kickoffMs < nowMs) return; // started but no scores yet → still wait

      const homepageHit = homepageGames.get(key);

      upcomingGames.push({
        id:         homepageHit ? `ff_${homepageHit.fanfootyId}` : `up_${currentRound}_${gameCounter++}`,
        fanfootyId: homepageHit ? homepageHit.fanfootyId : null,
        liveUrl:    homepageHit ? homepageHit.liveUrl    : null,
        round:      currentRound,
        teamA:      { name: teamA.names[0], abbr: teamA.abbr, color: teamA.color, score: 0, goals: 0, behinds: 0, _key: teamA.key },
        teamB:      { name: teamB.names[0], abbr: teamB.abbr, color: teamB.color, score: 0, goals: 0, behinds: 0, _key: teamB.key },
        quarter:       null,
        timeRemaining: null,
        venue,
        date:          dateText,
        time:          time ? `${time} AET` : null,
        status:        'upcoming',
        players:       [],
      });
    } catch (e) {
      console.warn('[parseFixture] Skipped row:', e.message);
    }
  });

  return { upcomingGames, kickoffByPair };
}

// ─── CLASSIFY SCORED GAMES ────────────────────────────────────────────────────

/**
 * Split scoredGames into liveGames (kickoff within last 3.5h) and pastGames
 * (kickoff older). When kickoff time is unknown, assume live — the frontend
 * will render correctly either way and the next poll will resolve it.
 *
 * Also enriches each game with venue/date/time from the fixture lookup.
 */
function classifyScoredGames(scoredGames, kickoffByPair, now) {
  const liveGames = [];
  const pastGames = [];
  const nowMs     = now.getTime();

  for (const game of scoredGames) {
    const key = pairKey(game.teamA._key, game.teamB._key);
    const fixtureInfo = kickoffByPair.get(key);

    if (fixtureInfo) {
      game.venue = fixtureInfo.venue || game.venue;
      game.date  = fixtureInfo.date  || game.date;
      game.time  = fixtureInfo.time ? `${fixtureInfo.time} AET` : game.time;
    }

    const kickoffMs = fixtureInfo ? fixtureInfo.kickoffMs : null;

    // Strip internal _key fields from team objects before sending to client
    delete game.teamA._key;
    delete game.teamB._key;

    if (kickoffMs === null) {
      // Unknown kickoff — assume live so the user sees the latest scores
      game.status = 'live';
      liveGames.push(game);
      continue;
    }

    const elapsed = nowMs - kickoffMs;
    if (elapsed >= 0 && elapsed <= LIVE_WINDOW_MS) {
      game.status = 'live';
      liveGames.push(game);
    } else if (elapsed > LIVE_WINDOW_MS) {
      game.status = 'final';
      // For final games, set quarter to 4 and time to "0:00" so the UI can
      // distinguish them from live games waiting on quarter info.
      game.quarter       = 4;
      game.timeRemaining = '0:00';
      pastGames.push(game);
    } else {
      // kickoff is in the future but we have scores? Shouldn't happen, but
      // be defensive — treat as live.
      game.status = 'live';
      liveGames.push(game);
    }
  }

  return { liveGames, pastGames };
}

// ─── DATE PARSING (Melbourne time) ────────────────────────────────────────────

/**
 * Parse a fixture date+time into a UTC millisecond timestamp anchored in
 * Melbourne local time (AEST UTC+10 / AEDT UTC+11).
 *
 * Inputs are loose: dateText might be "Saturday March 14" or "March 14",
 * timeText might be "4:15pm" or "7.25" or "12:35 PM".
 * Returns null if parsing fails.
 *
 * Strategy: format a candidate ISO-like string, parse it as if UTC, then
 * shift by Melbourne's current offset for that calendar date. We use
 * Intl.DateTimeFormat to determine the offset (handles AEDT/AEST DST
 * automatically) — no external date library needed.
 */
function parseKickoffMs(dateText, timeText, round) {
  if (!dateText || !timeText) return null;

  // Normalise date text: drop weekday, keep "March 14" / "14 March" / "Mar 14"
  const cleanDate = dateText.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+/i, '').trim();
  const dateMatch = cleanDate.match(
    /(?:(\d{1,2})\s+([A-Za-z]+))|(?:([A-Za-z]+)\s+(\d{1,2}))/,
  );
  if (!dateMatch) return null;

  const day      = parseInt(dateMatch[1] || dateMatch[4], 10);
  const monthStr = (dateMatch[2] || dateMatch[3] || '').toLowerCase();
  const monthIdx = MONTHS.findIndex(m => m.startsWith(monthStr.slice(0, 3)));
  if (monthIdx === -1) return null;

  // Time: "4:15pm", "7.25 PM", "12:35", "19:30"
  const tm = timeText.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!tm) return null;
  let hour   = parseInt(tm[1], 10);
  const min  = parseInt(tm[2], 10);
  const mer  = (tm[3] || '').toLowerCase();
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  // FanFooty's fixture page uses 24-hour-ish times (7.25 = evening) when no
  // meridiem is given. AFL games never start before 11am or after 9pm
  // Melbourne time; if a sub-12 hour comes in without am/pm and the round
  // is in season (post-March), treat <11 as PM (e.g. 7.25 → 19:25).
  if (!mer && hour < 11) hour += 12;

  // Resolve the year. AFL season runs March–September, but finals push into
  // late September/October. Use current Melbourne year as default; if the
  // computed date is more than 30 days in the past, roll forward a year.
  const melbNow = nowInMelbourne();
  let year = melbNow.year;

  // Build the candidate Melbourne-local datetime
  const candidateMs = melbourneDateToUtcMs(year, monthIdx, day, hour, min);
  if (candidateMs === null) return null;

  // If the candidate is >30 days in the past, the year is wrong (rolled over)
  if ((Date.now() - candidateMs) > 30 * 24 * 60 * 60 * 1000) {
    return melbourneDateToUtcMs(year + 1, monthIdx, day, hour, min);
  }
  return candidateMs;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Get the current date components AS THEY APPEAR in Melbourne local time.
 * Used to anchor year resolution in parseKickoffMs.
 */
function nowInMelbourne() {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  return {
    year:   parseInt(parts.year, 10),
    month:  parseInt(parts.month, 10) - 1,
    day:    parseInt(parts.day, 10),
    hour:   parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

/**
 * Convert (year, monthIdx, day, hour, min) interpreted as Melbourne local
 * time into a UTC millisecond timestamp.
 *
 * Approach: construct a Date as if the components were UTC, then determine
 * the Melbourne UTC offset for that wall-clock instant via Intl, and
 * subtract the offset. Iterate once because the offset itself depends on
 * the local time (DST boundary edge cases) — one pass is sufficient since
 * AEDT↔AEST transitions don't span more than 1 hour.
 */
function melbourneDateToUtcMs(year, monthIdx, day, hour, min) {
  // Initial guess: pretend it's UTC
  let utcGuess = Date.UTC(year, monthIdx, day, hour, min, 0);

  // Determine Melbourne offset at that guess
  const offsetMin = melbourneOffsetMinutesAt(utcGuess);
  if (offsetMin === null) return null;

  // Adjust: the real UTC time is the wall-clock minus the offset
  let result = utcGuess - offsetMin * 60 * 1000;

  // Re-check offset around the result (handles DST boundary)
  const refinedOffset = melbourneOffsetMinutesAt(result);
  if (refinedOffset !== null && refinedOffset !== offsetMin) {
    result = utcGuess - refinedOffset * 60 * 1000;
  }
  return result;
}

/**
 * Returns Melbourne's UTC offset (in minutes) at a given UTC instant.
 * AEST = +600, AEDT = +660. Implemented via Intl rather than hardcoded DST
 * dates so it's correct indefinitely without maintenance.
 */
function melbourneOffsetMinutesAt(utcMs) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Melbourne',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]),
    );
    const localMs = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      parseInt(parts.hour, 10),
      parseInt(parts.minute, 10),
    );
    return Math.round((localMs - utcMs) / 60000);
  } catch {
    return null;
  }
}

// ─── TEAM RESOLUTION ──────────────────────────────────────────────────────────

/**
 * Resolve any team name/abbreviation to its canonical TEAMS entry.
 * Case-insensitive, matches against every entry in `names`.
 * Returns null if no match.
 */
function findTeamByAnyName(input) {
  if (!input) return null;
  const needle = input.trim().toLowerCase();
  for (const team of TEAMS) {
    for (const n of team.names) {
      if (n.toLowerCase() === needle) return team;
    }
  }
  // Substring fallback — handles things like "Brisbane Lions vs..." where
  // the trim picked up extra characters. Match on team's primary name only
  // to avoid ambiguity (e.g. "Coast" matching both Gold Coast and West Coast).
  for (const team of TEAMS) {
    if (needle.includes(team.names[0].toLowerCase())) return team;
  }
  return null;
}

/**
 * Canonical pair key — order-independent identifier for a matchup.
 * Inputs should be canonical team keys (from TEAMS[].key).
 */
function pairKey(a, b) {
  return [a, b].sort().join('__');
}