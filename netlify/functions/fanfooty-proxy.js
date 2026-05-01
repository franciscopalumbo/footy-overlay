/**
 * FootyOverlay — FanFooty Proxy Netlify Function
 * File: /netlify/functions/fanfooty-proxy.js
 *
 * DEPENDENCIES:
 *   npm install node-fetch cheerio
 *
 * ENVIRONMENT VARIABLES:
 *   FANFOOTY_MOCK=true   — skip all scraping, return MOCK_RESPONSE
 *
 * ENDPOINT (via netlify.toml redirect):
 *   GET /api/fanfooty-proxy
 *
 * RESPONSE SHAPE:
 *   { round, liveGames: Game[], upcomingGames: Game[] }
 *
 * ─────────────────────────────────────────────────────────────
 * ARCHITECTURE — WHY THESE TWO PAGES:
 *
 *   (A) /game/roundscores.php  — server-rendered HTML. Contains every
 *       player's DT (AFL Fantasy) and SC (SuperCoach) score for the
 *       current round, grouped by game, as a real <table>. This is the
 *       primary source for player fantasy scores.
 *
 *       CONFIRMED STRUCTURE (verified against live 2026 data):
 *         · A "team header" <td> (no child <a> links) contains text like:
 *             "Brisbane: 17.17.119"   or   "Collingwood: 10.5.65"
 *           The score string follows "TeamName: G.B.Total".
 *         · Immediately after: a column header row — Player | DT | SC | Y! | FR | GS
 *         · Then N player rows, each with:
 *             <td><a href="/player/{slug}">Player Name</a></td>
 *             <td>DT</td> <td>SC</td> <td>Y!</td> <td>FR</td> <td>GS</td>
 *         · Two consecutive team headers = one game.
 *         · Game ID links near each block: href="/game/direct.php?id=8832"
 *         · Round number in <title>: "Round 4 Fantasy Scores @ FanFooty"
 *
 *   (B) /game/fixture.php  — server-rendered HTML. Full season fixture.
 *
 *       CONFIRMED STRUCTURE (verified against live 2026 data):
 *         · One large <table>.
 *         · Round header rows: "Round N | Date | Opponents | Ground | Time (AET)"
 *         · Game rows: "Day | Date | Team A vs Team B | Ground | Time"
 *         · "vs" always separates the two teams in the Opponents cell.
 *
 *   (C) /live/{year}/{id}-{slug}.html  — JS-rendered matchcentre.
 *       NOT scrapeable server-side — the page shell says "Loading data..."
 *       and the player stats table (Kk/Hb/Mk/Tk columns) only renders
 *       in-browser via AJAX. We therefore source all player scores from
 *       roundscores.php (DT and SC already computed by FanFooty).
 *
 * ─────────────────────────────────────────────────────────────
 * RESILIENCE STRATEGY:
 *   Every selector is wrapped in try/catch. Failed game/player rows are
 *   skipped without aborting. Top-level fetch failures fall back to
 *   MOCK_RESPONSE so the front-end always receives something valid.
 * ─────────────────────────────────────────────────────────────
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URL        = 'https://www.fanfooty.com.au';
const YEAR            = new Date().getFullYear();
const FETCH_TIMEOUT_MS = 9000; // Netlify default limit is 10s

/** Browser-like request headers — minimises chance of a block/captcha page */
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.fanfooty.com.au/',
  'DNT':             '1',
};

// ─── TEAM COLOUR MAP ─────────────────────────────────────────────────────────
// Left-border accent colours used in the front-end game card stripe.
// Keys must match how team names appear in FanFooty HTML (case-insensitive
// substring matching is used in teamColour() below).
const TEAM_COLOURS = {
  'Adelaide':          '#002b5c',
  'Brisbane':          '#a30046',
  'Carlton':           '#003087',
  'Collingwood':       '#1a1a1a',
  'Essendon':          '#cc2200',
  'Fremantle':         '#2a0845',
  'Geelong':           '#1c3f6e',
  'Gold Coast':        '#e8281a',
  'Western Sydney':    '#f47920',  // GWS Giants — "G. W. Sydney" in nav
  'GWS':               '#f47920',
  'Hawthorn':          '#4d2004',
  'Melbourne':         '#0f1b56',
  'North Melbourne':   '#003087',
  'Port Adelaide':     '#009fd9',
  'Richmond':          '#ffd700',
  'St Kilda':          '#ed0f05',
  'Sydney':            '#ed0f05',
  'West Coast':        '#003087',
  'Western Bulldogs':  '#003087',
};

// ─── MOCK RESPONSE ────────────────────────────────────────────────────────────
// Returned when FANFOOTY_MOCK=true, or on total scraping failure.
// Scores include both scoreDT and scoreSC so the front-end can switch systems.
const MOCK_RESPONSE = {
  round: 14,
  liveGames: [
    {
      id: 'g001', fanfootyId: null,
      teamA: { name: 'Richmond',    abbr: 'RICH', color: '#ffd700', score: 72, goals: 10, behinds: 12 },
      teamB: { name: 'Collingwood', abbr: 'COLL', color: '#1a1a1a', score: 61, goals: 8,  behinds: 13 },
      quarter: 3, timeRemaining: '8:42', venue: 'MCG', status: 'live',
      players: [
        { id: 'dustin-martin',    jersey: 4,  name: 'Dustin Martin',    pos: 'MID', score: 88,  scoreDT: 88,  scoreSC: 91  },
        { id: 'shai-bolton',      jersey: 12, name: 'Shai Bolton',       pos: 'FWD', score: 54,  scoreDT: 54,  scoreSC: 49  },
        { id: 'jack-riewoldt',    jersey: 8,  name: 'Jack Riewoldt',     pos: 'FWD', score: 62,  scoreDT: 62,  scoreSC: 68  },
        { id: 'scott-pendlebury', jersey: 14, name: 'Scott Pendlebury',  pos: 'MID', score: 102, scoreDT: 102, scoreSC: 109 },
        { id: 'nick-daicos',      jersey: 35, name: 'Nick Daicos',       pos: 'MID', score: 118, scoreDT: 118, scoreSC: 124 },
        { id: 'jordan-de-goey',   jersey: 5,  name: 'Jordan De Goey',    pos: 'FWD', score: 76,  scoreDT: 76,  scoreSC: 72  },
      ],
    },
    {
      id: 'g002', fanfootyId: null,
      teamA: { name: 'Carlton',  abbr: 'CARL', color: '#003087', score: 45, goals: 6, behinds: 9  },
      teamB: { name: 'Hawthorn', abbr: 'HAW',  color: '#4d2004', score: 55, goals: 7, behinds: 14 },
      quarter: 2, timeRemaining: '14:21', venue: 'Marvel Stadium', status: 'live',
      players: [
        { id: 'patrick-cripps', jersey: 9,  name: 'Patrick Cripps', pos: 'MID', score: 95, scoreDT: 95, scoreSC: 101 },
        { id: 'sam-walsh',      jersey: 8,  name: 'Sam Walsh',       pos: 'MID', score: 67, scoreDT: 67, scoreSC: 63  },
        { id: 'james-sicily',   jersey: 8,  name: 'James Sicily',    pos: 'DEF', score: 74, scoreDT: 74, scoreSC: 79  },
        { id: 'jai-newcombe',   jersey: 12, name: 'Jai Newcombe',    pos: 'MID', score: 83, scoreDT: 83, scoreSC: 88  },
      ],
    },
  ],
  upcomingGames: [
    {
      id: 'g003', fanfootyId: null, round: 14, status: 'upcoming',
      teamA: { name: 'Geelong',   abbr: 'GEE',  color: '#1c3f6e', score: 0, goals: 0, behinds: 0 },
      teamB: { name: 'Brisbane',  abbr: 'BRL',  color: '#a30046', score: 0, goals: 0, behinds: 0 },
      quarter: 0, timeRemaining: '', venue: 'GMHBA Stadium',
      date: 'Sat 22 Jun', time: '7:25 PM AET', players: [],
    },
    {
      id: 'g004', fanfootyId: null, round: 14, status: 'upcoming',
      teamA: { name: 'Essendon',  abbr: 'ESS',  color: '#cc2200', score: 0, goals: 0, behinds: 0 },
      teamB: { name: 'GWS Giants',abbr: 'GWSG', color: '#f47920', score: 0, goals: 0, behinds: 0 },
      quarter: 0, timeRemaining: '', venue: 'Marvel Stadium',
      date: 'Sun 23 Jun', time: '12:35 PM AET', players: [],
    },
  ],
};

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache, no-store',
  };

  // ── Mock mode shortcut ─────────────────────────────────────────────────────
  if (process.env.FANFOOTY_MOCK === 'true') {
    console.log('[fanfooty-proxy] FANFOOTY_MOCK=true — returning mock data');
    return { statusCode: 200, headers, body: JSON.stringify(MOCK_RESPONSE) };
  }

  // ── Live scrape ────────────────────────────────────────────────────────────
  try {
    // Fetch both pages in parallel to stay within the 10s Lambda limit
    const [roundScoresHtml, fixtureHtml] = await Promise.all([
      fetchPage(`${BASE_URL}/game/roundscores.php`),
      fetchPage(`${BASE_URL}/game/fixture.php`),
    ]);

    const $scores  = cheerio.load(roundScoresHtml);
    const $fixture = cheerio.load(fixtureHtml);

    const { round, liveGames, completedTeamPairs } = parseRoundScores($scores);
    const upcomingGames = parseFixture($fixture, round, completedTeamPairs);

    const payload = { round, liveGames, upcomingGames };
    console.log(`[fanfooty-proxy] OK — R${round}: ${liveGames.length} scored games, ${upcomingGames.length} upcoming`);
    return { statusCode: 200, headers, body: JSON.stringify(payload) };

  } catch (err) {
    console.error('[fanfooty-proxy] Fatal scrape error:', err.message);
    // Always return 200 with mock data — front-end shows mock badge via _fallback flag
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...MOCK_RESPONSE, _fallback: true, _error: err.message }),
    };
  }
};

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL with browser-like headers and a hard timeout.
 * @param {string} url
 * @returns {Promise<string>} HTML text
 */
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

// ─── ROUND SCORES PARSER ──────────────────────────────────────────────────────

/**
 * Parse /game/roundscores.php
 *
 * The page is a single large HTML table. We identify "team header" cells —
 * <td> elements whose text matches "TeamName: G.B.Total" and contain no
 * child <a> links. These cells delimit game blocks. Teams appear in pairs;
 * each pair = one game.
 *
 * Player rows immediately follow their team's header and contain:
 *   <td><a href="/player/{slug}">Name</a></td> <td>DT</td> <td>SC</td> ...
 *
 * @param {CheerioAPI} $
 * @returns {{ round, liveGames, completedTeamPairs }}
 */
function parseRoundScores($) {
  // ── 1. Extract round number ───────────────────────────────────────────────
  let round = 0;
  try {
    // Primary: <title> contains "Round 4 Fantasy Scores @ FanFooty"
    const titleMatch = $('title').text().match(/Round\s+(\d+)/i);
    if (titleMatch) {
      round = parseInt(titleMatch[1]);
    } else {
      // Fallback: search headings and table cells for "Round N"
      $('h1, h2, h3, h4, b, strong, td').each((_, el) => {
        if (round) return false; // stop iteration once found
        const m = $(el).text().trim().match(/^(?:Fantasy Scores[:\s]+)?Round\s+(\d+)/i);
        if (m) round = parseInt(m[1]);
      });
    }
  } catch (e) {
    console.warn('[parseRoundScores] Round number extraction failed:', e.message);
  }

  // ── 2. Find all team header cells ────────────────────────────────────────
  //   Matching pattern: text like "Brisbane: 17.17.119" or "Brisbane: 17.17"
  //   Cell must NOT contain an <a> child (which would make it a player cell).
  const teamHeaderCells = [];

  $('td').each((_, el) => {
    const $el = $(el);
    if ($el.find('a').length > 0) return; // player or link cell — skip
    const text = $el.text().trim();
    // "TeamName: G.B.T" — colon followed by two or three dot-separated numbers
    if (/^[A-Za-z][\w\s.]+:\s*\d+\.\d+(\.\d+)?$/.test(text)) {
      teamHeaderCells.push({ el, text });
    }
  });

  // ── 3. Pair headers into games and collect players ────────────────────────
  const liveGames = [];
  const completedTeamPairs = new Set(); // for deduplication in fixture parser

  for (let i = 0; i + 1 < teamHeaderCells.length; i += 2) {
    try {
      const teamAMeta = parseTeamHeader(teamHeaderCells[i].text);
      const teamBMeta = parseTeamHeader(teamHeaderCells[i + 1].text);
      if (!teamAMeta || !teamBMeta) continue;

      // Collect players for each team by walking the sibling <tr>s after
      // each header cell. Stop at the next team header.
      const stopBoundaryForA = teamHeaderCells[i + 1].el;
      const stopBoundaryForB = teamHeaderCells[i + 2] ? teamHeaderCells[i + 2].el : null;

      const teamAPlayers = collectPlayerRows($, teamHeaderCells[i].el, stopBoundaryForA);
      const teamBPlayers = collectPlayerRows($, teamHeaderCells[i + 1].el, stopBoundaryForB);

      // Extract numeric FanFooty game ID from a direct.php or /live/ link
      // that appears in the same table as this game block.
      const fanfootyId = extractGameId($, teamHeaderCells[i].el);
      const gameId     = fanfootyId ? `ff_${fanfootyId}` : `g_${i / 2}`;

      // Track which team pairs we've seen (for upcoming dedup)
      completedTeamPairs.add(pairKey(teamAMeta.name, teamBMeta.name));

      liveGames.push({
        id:         gameId,
        fanfootyId: fanfootyId,
        teamA: { ...teamAMeta, color: teamColour(teamAMeta.name) },
        teamB: { ...teamBMeta, color: teamColour(teamBMeta.name) },
        // Quarter and time-remaining are only in the JS-rendered matchcentre;
        // they cannot be scraped here. The front-end will show "LIVE" badge
        // without a specific time when these are 0/''.
        quarter:       0,
        timeRemaining: '',
        venue:         '',
        // All games on roundscores.php have scores — mark as live.
        // The front-end may further classify as 'final' based on context.
        status: 'live',
        liveUrl: fanfootyId
          ? `${BASE_URL}/live/${YEAR}/${fanfootyId}-${slugify(teamAMeta.name)}-${slugify(teamBMeta.name)}.html`
          : null,
        players: [...teamAPlayers, ...teamBPlayers],
      });
    } catch (e) {
      console.warn(`[parseRoundScores] Skipped game pair ${i}:`, e.message);
    }
  }

  return { round, liveGames, completedTeamPairs };
}

/**
 * Parse a team header cell's text into structured team metadata.
 *
 * Input examples:
 *   "Brisbane: 17.17.119"       → goals=17, behinds=17, score=119
 *   "North Melbourne: 14.12.96" → goals=14, behinds=12, score=96
 *   "Collingwood: 10.5"         → goals=10, behinds=5, score=65 (computed)
 *
 * @param {string} text
 * @returns {{ name, abbr, score, goals, behinds } | null}
 */
function parseTeamHeader(text) {
  // Regex: everything before the colon = team name; then G.B or G.B.T
  const match = text.match(/^(.+?):\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const name    = match[1].trim();
  const goals   = parseInt(match[2]) || 0;
  const behinds = parseInt(match[3]) || 0;
  // Total score may be explicit ("17.17.119") or computed ("17.17" → 17*6+17=119)
  const score   = match[4] !== undefined ? parseInt(match[4]) : (goals * 6 + behinds);

  return { name, abbr: abbreviate(name), score, goals, behinds };
}

/**
 * Walk the <tr> siblings after a team header cell and collect player rows.
 * Stops when it hits the row containing `stopBoundaryCell`, another team
 * header pattern, or a safety cap.
 *
 * Player row structure (confirmed from roundscores.php):
 *   col 0 — <a href="/player/{slug}">Player Name</a>
 *   col 1 — DT score  (AFL Fantasy)
 *   col 2 — SC score  (SuperCoach)
 *   col 3 — Y! score  (Yahoo — ignored)
 *   col 4 — FR score  (FootyRanks — ignored)
 *   col 5 — GS score  (FanFooty Game Score — ignored)
 *
 * @param {CheerioAPI} $
 * @param {Element}    headerCell        - the team's <td> header element
 * @param {Element}    [stopBoundaryCell] - next team's <td> header (exclusive)
 * @returns {Player[]}
 */
function collectPlayerRows($, headerCell, stopBoundaryCell) {
  const players = [];
  const stopRow = stopBoundaryCell ? $(stopBoundaryCell).closest('tr') : null;

  let currentRow = $(headerCell).closest('tr').next();
  let guard = 0;
  const MAX_ROWS = 60; // no team ever fields 60 players

  while (currentRow.length && guard++ < MAX_ROWS) {
    // Stop if we've reached the boundary row
    if (stopRow && currentRow.is(stopRow)) break;

    const cells = currentRow.find('td');
    if (!cells.length) { currentRow = currentRow.next(); continue; }

    const firstCell = $(cells[0]);
    const playerLink = firstCell.find('a[href*="/player/"]');

    if (playerLink.length > 0) {
      // This is a player row
      try {
        const name    = playerLink.text().trim();
        const href    = playerLink.attr('href') || '';
        // Slug: "/player/will-ashcroft" → "will-ashcroft"
        const slug    = href.replace(/^.*\/player\//, '').replace(/\/$/, '');
        const dtScore = parseInt($(cells[1]).text().trim()) || 0;
        const scScore = parseInt($(cells[2]).text().trim()) || 0;

        if (name) {
          players.push({
            id:      slug || `player_${players.length}`,
            jersey:  null, // not present on roundscores.php
            name,
            pos:     'MID', // position not present on roundscores.php
            score:   dtScore,    // front-end uses scoreDT or scoreSC per toggle
            scoreDT: dtScore,
            scoreSC: scScore,
            stats:   {},         // raw stat counts unavailable from this page
          });
        }
      } catch (e) {
        // Malformed player row — skip silently
      }
    } else {
      // Non-player row: could be a column header ("Player DT SC ..."),
      // a blank separator, or the start of the next team block.
      const rowText = currentRow.text().replace(/\s+/g, ' ').trim();

      // If it looks like a team header, we've overshot — stop.
      if (/^[A-Za-z][\w\s.]+:\s*\d+\.\d+/.test(rowText)) break;
    }

    currentRow = currentRow.next();
  }

  return players;
}

/**
 * Extract the FanFooty numeric game ID by searching for
 * "direct.php?id=N" or "/live/{year}/N-" links near the header cell.
 *
 * @param {CheerioAPI} $
 * @param {Element}    nearCell
 * @returns {number|null}
 */
function extractGameId($, nearCell) {
  const table = $(nearCell).closest('table');
  const link  = table.find('a[href*="direct.php?id="], a[href*="/live/"]').first();
  if (!link.length) return null;

  const href = link.attr('href') || '';
  const direct = href.match(/direct\.php\?id=(\d+)/);
  if (direct) return parseInt(direct[1]);
  const live = href.match(/\/live\/\d+\/(\d+)-/);
  if (live) return parseInt(live[1]);
  return null;
}

// ─── FIXTURE PARSER ───────────────────────────────────────────────────────────

/**
 * Parse /game/fixture.php to find upcoming games.
 *
 * Only returns games from the current round and (at most) the next round.
 * Skips any team pair that already appears in completedTeamPairs (because
 * roundscores.php already has it, meaning the game has been played).
 *
 * CONFIRMED COLUMN ORDER (from 2026 fixture, verified):
 *   Round header row:  "Round N" | "Date" | "Opponents" | "Ground" | "Time (AET)"
 *   Game row:          "Saturday" | "March 14" | "Team A vs Team B" | "Kardinia" | "4:15pm"
 *   Some game rows omit the day cell if it's the same day as the row above.
 *
 * @param {CheerioAPI} $
 * @param {number} currentRound
 * @param {Set<string>} completedTeamPairs
 * @returns {Game[]}
 */
function parseFixture($, currentRound, completedTeamPairs) {
  const upcoming       = [];
  let   fixtureRound   = 0;
  let   gameCounter    = 0;
  const MAX_AHEAD      = 1; // show current + 1 round ahead

  $('table tr').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (!cells.length) return;

    const firstText = $(cells[0]).text().trim();

    // ── Round header detection ───────────────────────────────────────────────
    // "Round 14", "Round P1" (preseason), "Round HA" (home-and-away opener)
    const roundMatch = firstText.match(/^Round\s+(\d+)/i);
    if (roundMatch) {
      fixtureRound = parseInt(roundMatch[1]);
      return; // header row, not a game
    }

    // Only process games within our window
    if (fixtureRound < currentRound || fixtureRound > currentRound + MAX_AHEAD) return;

    // ── Game row: find the cell containing " vs " ────────────────────────────
    let vsIdx = -1;
    cells.each((idx, cell) => {
      if ($(cell).text().includes(' vs ')) vsIdx = idx;
    });
    if (vsIdx === -1) return;

    try {
      const opponentsText = $(cells[vsIdx]).text().trim();
      const vsParts = opponentsText.split(' vs ');
      if (vsParts.length < 2) return;
      const teamAName = vsParts[0].trim();
      const teamBName = vsParts[1].trim();
      if (!teamAName || !teamBName) return;

      // Skip games that already have scores (appear in roundscores.php)
      if (completedTeamPairs.has(pairKey(teamAName, teamBName))) return;

      // ── Extract date, venue, time from surrounding cells ─────────────────
      // Layout (verified): [Day?] [Date] [TeamA vs TeamB] [Ground] [Time]
      // Some rows collapse the Day cell, so vsIdx can be 1, 2, or 3.
      let dateText  = '';
      let venueText = '';
      let timeText  = '';

      if (vsIdx >= 2) {
        // Cells: 0=Day, 1=Date, 2=Opponents
        dateText = [$(cells[vsIdx - 2]).text().trim(), $(cells[vsIdx - 1]).text().trim()]
          .filter(Boolean).join(' ');
      } else if (vsIdx === 1) {
        // Cells: 0=Date, 1=Opponents (day merged above)
        dateText = $(cells[0]).text().trim();
      }

      if (cells.length > vsIdx + 1) venueText = $(cells[vsIdx + 1]).text().trim();
      if (cells.length > vsIdx + 2) timeText  = $(cells[vsIdx + 2]).text().trim();

      upcoming.push({
        id:         `upcoming_${gameCounter++}`,
        fanfootyId: null,
        round:      fixtureRound,
        teamA:      { name: teamAName, abbr: abbreviate(teamAName), color: teamColour(teamAName), score: 0, goals: 0, behinds: 0 },
        teamB:      { name: teamBName, abbr: abbreviate(teamBName), color: teamColour(teamBName), score: 0, goals: 0, behinds: 0 },
        quarter:       0,
        timeRemaining: '',
        venue:         venueText,
        date:          dateText,
        time:          timeText ? `${timeText} AET` : '',
        status:        'upcoming',
        players:       [],
      });
    } catch (e) {
      console.warn('[parseFixture] Skipped row:', e.message);
    }
  });

  return upcoming;
}

// ─── UTILITY ─────────────────────────────────────────────────────────────────

/**
 * Returns a hex colour for a team name using case-insensitive substring
 * matching against TEAM_COLOURS keys. Falls back to neutral grey.
 */
function teamColour(name) {
  if (!name) return '#555';
  const n = name.toLowerCase();
  for (const [key, colour] of Object.entries(TEAM_COLOURS)) {
    if (n.includes(key.toLowerCase()) || key.toLowerCase().includes(n)) return colour;
  }
  return '#555';
}

/**
 * 4-char uppercase abbreviation for a team name.
 * "North Melbourne" → "NMEL", "Western Sydney" → "WSYD", "Geelong" → "GEEL"
 */
function abbreviate(name) {
  if (!name) return '???';
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name.substring(0, 4).toUpperCase();
  return (words[0][0] + words.slice(1).join('').substring(0, 3)).toUpperCase();
}

/**
 * URL-safe slug: "North Melbourne" → "north-melbourne"
 */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Canonical sort-independent key for a team pair — used to detect if a
 * fixture game has already been played (appears in roundscores.php).
 * "Brisbane", "Collingwood" and "Collingwood", "Brisbane" produce same key.
 */
function pairKey(a, b) {
  return [a.toLowerCase().replace(/\s/g,''), b.toLowerCase().replace(/\s/g,'')]
    .sort().join('_');
}