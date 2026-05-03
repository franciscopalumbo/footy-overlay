/**
 * FootyOverlay — FanFooty Proxy Netlify Function
 * File: /netlify/functions/fanfooty-proxy.js
 *
 * DEPENDENCIES:
 *   npm install cheerio
 *
 *   We use the native fetch() global, which is built into Node.js 18+ and
 *   therefore available in Netlify Functions without any package install.
 *
 *   We import from `cheerio/slim`, NOT the default `cheerio` entry. The
 *   default entry eagerly requires undici v7 (for cheerio.fromURL) which
 *   uses Node 20+ globals and crashes on Node 18 at module load time.
 *
 * ENVIRONMENT VARIABLES:
 *   FANFOOTY_LIVE=true   — perform real scraping. Anything else (or unset)
 *                          serves MOCK_RESPONSE.
 *   FANFOOTY_DEBUG=true  — dump structural diagnostics to console.log so
 *                          you can paste Netlify logs and trace parser
 *                          behaviour without re-fetching live HTML.
 *
 * ENDPOINT (via netlify.toml redirect):
 *   GET /api/fanfooty-proxy
 *
 * ─────────────────────────────────────────────────────────────
 * SCRAPED DATA SCOPE — IMPORTANT:
 *
 *   FanFooty's terms permit scraping the DT and SC fantasy scores only.
 *   Raw stats (kicks, handballs, marks, tackles, hit-outs, free kicks,
 *   metres gained, contested possessions, clearances, disposal efficiency,
 *   time on ground) are OFF LIMITS and are NOT collected.
 *
 *   Public match scores in G.B.T format ("Collingwood: 15.3.93") are part
 *   of the published scoreboard text and are kept on the team object so
 *   the frontend can display final-score lines. Quarter and time-remaining
 *   stay null — they live in the JS-rendered matchcentre, which we don't
 *   scrape.
 *
 * ─────────────────────────────────────────────────────────────
 * RESPONSE SHAPE (top-level keys are guaranteed to exist; values may be []):
 *   {
 *     round:         number,
 *     liveGames:     Game[],   // games kicked off within the last ~3.5h
 *     upcomingGames: Game[],   // games whose kickoff is still in the future
 *     pastGames:     Game[],   // games kicked off >3.5h ago
 *     _fallback:     boolean,  // optional: true when mock served due to error
 *     _error:        string,   // optional: error summary when _fallback=true
 *   }
 *
 *   Each Game contains:
 *     teamA / teamB: { name, abbr, color, score, goals, behinds }
 *     players:       Player[]
 *
 *   Each Player is intentionally minimal:
 *     { id, name, scoreDT, scoreSC, jersey, pos }
 *   `jersey` and `pos` are always null in this layer — populated, if at
 *   all, by Layer 2 (matchcentre JSON polling, not yet implemented).
 *
 * ─────────────────────────────────────────────────────────────
 * ARCHITECTURE — verified against live Round 8 data on 3 May 2026:
 *
 *   FIXTURE.PHP is the source of truth for which games exist in the round.
 *   It is one big <table> covering the whole season. Each round has a
 *   header row "Round N | Date | Opponents | Ground | Time (AET)" followed
 *   by game rows. Game rows have columns:
 *     [Day]  [Date]  [Team A vs Team B]  [Ground]  [Time]
 *   When consecutive rows share the same day+date, BOTH the day and date
 *   cells are blank — not just the day cell. We track lastDay/lastDate
 *   across rows to fill these in.
 *
 *   ROUNDSCORES.PHP enriches scored games with per-player DT/SC scores.
 *   Each game = ONE outer <table> with one <tr> containing THREE direct
 *   <td> cells: [teamA wrapper] [spacer] [teamB wrapper]. Each wrapper
 *   contains a nested <table> whose:
 *     · <caption> holds the team header text e.g. "Collingwood: 15.3.93"
 *     · first <tr> is column labels: "Player DT SC Y! FR GS" (and "BL"
 *       as a 7th column for Essendon games only)
 *     · subsequent <tr>s are player rows: <td>name-link</td><td>DT</td>
 *       <td>SC</td><td>Y!</td><td>FR</td><td>GS</td>[<td>BL</td>]
 *   We read DT and SC only — Y!/FR/GS/BL are alternative fantasy systems
 *   we don't support and are deliberately ignored.
 *
 *   HOMEPAGE renders the current round as a list of <a> elements pointing
 *   to /live/{year}/{id}-{slug}.html. Link text contains kickoff datetime,
 *   two abbreviations on separate lines, and (for completed/in-progress
 *   games) two scores. We use this to recover FanFooty's canonical numeric
 *   game IDs and the official /live/ URLs.
 *
 *   The matchcentre at /live/{year}/{id}-{slug}.html is JS-rendered. We
 *   do NOT scrape it. quarter, timeRemaining, jersey, position stay null.
 *
 * ─────────────────────────────────────────────────────────────
 * RESILIENCE:
 *   Every parser is wrapped in try/catch. Failed games/players are
 *   skipped without aborting. Top-level fetch failures fall back to
 *   MOCK_RESPONSE so the frontend always receives a valid payload.
 *   30s module-scoped cache prevents pounding FanFooty.
 * ─────────────────────────────────────────────────────────────
 */

const cheerio = require('cheerio/slim');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URL         = 'https://www.fanfooty.com.au';
const FETCH_TIMEOUT_MS = 9000;
const CACHE_TTL_MS     = 30 * 1000;

/** Window after kickoff during which a game is "live" rather than "final". */
const LIVE_WINDOW_MS = 3.5 * 60 * 60 * 1000;

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (FootyOverlay/1.0; +https://github.com/franciscopalumbo/footy-overlay) Chrome/124.0.0.0',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer':         'https://www.fanfooty.com.au/',
};

// ─── TEAM METADATA ────────────────────────────────────────────────────────────

const TEAMS = [
  { key: 'adelaide',        names: ['Adelaide', 'Adelaide Crows', 'Crows', 'ADE'],            abbr: 'ADE',  color: '#002b5c' },
  { key: 'brisbane',        names: ['Brisbane', 'Brisbane Lions', 'Lions', 'BRI', 'BL'],      abbr: 'BRI',  color: '#a30046' },
  { key: 'carlton',         names: ['Carlton', 'Carlton Blues', 'Blues', 'CAR'],              abbr: 'CAR',  color: '#003087' },
  { key: 'collingwood',     names: ['Collingwood', 'Magpies', 'COL'],                         abbr: 'COL',  color: '#1a1a1a' },
  { key: 'essendon',        names: ['Essendon', 'Bombers', 'ESS'],                            abbr: 'ESS',  color: '#cc2200' },
  { key: 'fremantle',       names: ['Fremantle', 'Dockers', 'FRE'],                           abbr: 'FRE',  color: '#2a0845' },
  { key: 'geelong',         names: ['Geelong', 'Cats', 'GEE'],                                abbr: 'GEE',  color: '#1c3f6e' },
  { key: 'goldcoast',       names: ['Gold Coast', 'Suns', 'GC'],                              abbr: 'GC',   color: '#e8281a' },
  { key: 'gws',             names: ['GWS', 'Greater Western Sydney', 'GWS Giants', 'Giants', 'Western Sydney', 'G. W. Sydney'], abbr: 'GWS', color: '#f47920' },
  { key: 'hawthorn',        names: ['Hawthorn', 'Hawks', 'HAW'],                              abbr: 'HAW',  color: '#4d2004' },
  { key: 'melbourne',       names: ['Melbourne', 'Demons', 'MEL'],                            abbr: 'MEL',  color: '#0f1b56' },
  { key: 'northmelbourne',  names: ['North Melbourne', 'Kangaroos', 'NM', 'North'],           abbr: 'NM',   color: '#003087' },
  { key: 'portadelaide',    names: ['Port Adelaide', 'Power', 'PTA', 'PA', 'Port'],           abbr: 'PTA',  color: '#009fd9' },
  { key: 'richmond',        names: ['Richmond', 'Tigers', 'RIC', 'RI'],                       abbr: 'RIC',  color: '#ffd700' },
  { key: 'stkilda',         names: ['St Kilda', 'Saints', 'STK'],                             abbr: 'STK',  color: '#ed0f05' },
  { key: 'sydney',          names: ['Sydney', 'Sydney Swans', 'Swans', 'SYD'],                abbr: 'SYD',  color: '#ed0f05' },
  { key: 'westcoast',       names: ['West Coast', 'West Coast Eagles', 'Eagles', 'WCE', 'WC'], abbr: 'WCE', color: '#003087' },
  { key: 'westernbulldogs', names: ['Western Bulldogs', 'Bulldogs', 'WBD', 'WB', 'W. Bulldogs'], abbr: 'WBD', color: '#003087' },
];

// ─── MOCK RESPONSE ────────────────────────────────────────────────────────────

const MOCK_RESPONSE = {
  round: 14,
  liveGames: [
    {
      id: 'mock_g001', fanfootyId: null, liveUrl: null,
      teamA: { name: 'Richmond',    abbr: 'RIC', color: '#ffd700', score: 72, goals: 10, behinds: 12 },
      teamB: { name: 'Collingwood', abbr: 'COL', color: '#1a1a1a', score: 61, goals: 8,  behinds: 13 },
      quarter: 3, timeRemaining: '8:42', venue: 'MCG',
      date: 'Sat 22 Jun', time: '7:25 PM AET',
      status: 'live',
      players: [
        mockPlayer('dustin-martin', 'Dustin Martin',  88,  91),
        mockPlayer('nick-daicos',   'Nick Daicos',   118, 124),
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
  ],
  pastGames: [
    {
      id: 'mock_g005', fanfootyId: null, liveUrl: null,
      teamA: { name: 'Melbourne', abbr: 'MEL', color: '#0f1b56', score: 96,  goals: 14, behinds: 12 },
      teamB: { name: 'Sydney',    abbr: 'SYD', color: '#ed0f05', score: 102, goals: 15, behinds: 12 },
      quarter: 4, timeRemaining: '0:00', venue: 'MCG',
      date: 'Fri 21 Jun', time: '7:50 PM AET',
      status: 'final',
      players: [
        mockPlayer('clayton-oliver', 'Clayton Oliver', 134, 142),
      ],
    },
  ],
};

/**
 * Build a minimal mock player. Mirrors the live-scraped player shape:
 * scores only — no raw stats. jersey/pos are null as they're not
 * scraped in this layer.
 */
function mockPlayer(id, name, dt, sc) {
  return {
    id,
    name,
    jersey:  null,
    pos:     null,
    score:   dt,    // legacy alias — frontend reads scoreDT/scoreSC, but
                    // some older code paths fall back to .score
    scoreDT: dt,
    scoreSC: sc,
  };
}

// ─── MODULE-SCOPED CACHE ──────────────────────────────────────────────────────

let cache = { data: null, expiresAt: 0 };

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: jsonHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (process.env.FANFOOTY_LIVE !== 'true') {
    console.log('[fanfooty-proxy] FANFOOTY_LIVE!=true — returning mock data');
    return ok(MOCK_RESPONSE);
  }

  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    const ageMs = CACHE_TTL_MS - (cache.expiresAt - now);
    console.log(`[fanfooty-proxy] cache HIT (age ${Math.round(ageMs / 1000)}s)`);
    return ok(cache.data);
  }

  try {
    const [roundScoresHtml, fixtureHtml, homepageHtml] = await Promise.all([
      fetchPage(`${BASE_URL}/game/roundscores.php`),
      fetchPage(`${BASE_URL}/game/fixture.php`),
      fetchPage(`${BASE_URL}/`),
    ]);

    const $scores  = cheerio.load(roundScoresHtml);
    const $fixture = cheerio.load(fixtureHtml);
    const $home    = cheerio.load(homepageHtml);

    const round         = parseRoundNumber($scores);
    const homepageGames = parseHomepageGames($home);
    const fixtureGames  = parseFixtureRound($fixture, round);
    const playersByPair = parseRoundScores($scores);

    const games = mergeGames(fixtureGames, playersByPair, homepageGames);
    const { liveGames, upcomingGames, pastGames } = classifyGames(games, new Date());

    const payload = { round, liveGames, upcomingGames, pastGames };
    cache = { data: payload, expiresAt: now + CACHE_TTL_MS };

    console.log(
      `[fanfooty-proxy] OK — R${round}: ` +
      `${liveGames.length} live, ${upcomingGames.length} upcoming, ${pastGames.length} past` +
      ` (fixture=${fixtureGames.length}, scored=${playersByPair.size}, homepage=${homepageGames.size})`,
    );
    return ok(payload);

  } catch (err) {
    console.error('[fanfooty-proxy] Fatal scrape error:', err.message, err.stack);
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

// ─── ROUND NUMBER ─────────────────────────────────────────────────────────────

function parseRoundNumber($scores) {
  const titleText = $scores('title').text();
  let m = titleText.match(/Round\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);

  const bodyText = $scores('body').text();
  m = bodyText.match(/Fantasy Scores:?\s*Round\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);

  m = bodyText.match(/\bRound\s+(\d+)\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

// ─── HOMEPAGE PARSER ──────────────────────────────────────────────────────────

function parseHomepageGames($) {
  const games = new Map();

  $('a[href*="/live/"]').each((_, el) => {
    try {
      const $a = $(el);
      const href = $a.attr('href') || '';

      const urlMatch = href.match(/\/live\/(\d{4})\/(\d+)-([a-z0-9-]+)\.html/i);
      if (!urlMatch) return;

      const liveUrl    = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const fanfootyId = parseInt(urlMatch[2], 10);

      const text = $a.text().replace(/\s+/g, ' ').trim();

      const codeMatch = text.match(/\b([A-Z]{2,4})\b\s+\b([A-Z]{2,4})\b/);
      if (!codeMatch) return;

      const teamA = findTeamByAnyName(codeMatch[1]);
      const teamB = findTeamByAnyName(codeMatch[2]);
      if (!teamA || !teamB) return;

      const scoreMatch = text.match(/\b[A-Z]{2,4}\b\s+\b[A-Z]{2,4}\b\s+(\d+)\s+(\d+)/);
      const scoreA = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
      const scoreB = scoreMatch ? parseInt(scoreMatch[2], 10) : null;

      games.set(pairKey(teamA.key, teamB.key), {
        fanfootyId, liveUrl, scoreA, scoreB,
        teamAKey: teamA.key, teamBKey: teamB.key,
      });
    } catch (e) {
      // ignore individual parse failures
    }
  });

  return games;
}

// ─── ROUND SCORES PARSER ──────────────────────────────────────────────────────

/**
 * Parse roundscores.php into a Map<pairKey, GameScores>.
 *
 * VERIFIED PRODUCTION HTML STRUCTURE (3 May 2026):
 *   Each game = ONE outer <table> with one <tr> containing THREE direct
 *   <td> cells: [teamA wrapper] [spacer] [teamB wrapper]. Each wrapper
 *   contains a nested <table> whose:
 *     · <caption> holds the team header text e.g. "Collingwood: 15.3.93"
 *     · first <tr> is column labels (rows of <th>)
 *     · subsequent <tr>s are player rows
 *
 *     <table>                                           <-- outer game
 *       <tr>
 *         <td>
 *           <table>                                     <-- team A nested
 *             <caption>Collingwood: 15.3.93</caption>   <-- HEADER LIVES HERE
 *             <tr><th>Player</th><th>DT</th>...</tr>    <-- column labels
 *             <tr><td><a href=".../player/nick-daicos">Nick Daicos</a></td>
 *                 <td>124</td><td>103</td>...</tr>      <-- player row
 *             ...
 *           </table>
 *         </td>
 *         <td>&nbsp;</td>                               <-- spacer
 *         <td><table>...</table></td>                   <-- team B nested
 *       </tr>
 *     </table>
 */
function parseRoundScores($) {
  const result = new Map();

  const outerTables = $('table').filter((_, t) => $(t).parents('table').length === 0);

  outerTables.each((tIdx, table) => {
    try {
      const $table = $(table);
      let teamCells = $table.children('tbody').children('tr').children('td');
      if (teamCells.length === 0) {
        teamCells = $table.children('tr').children('td');
      }
      if (teamCells.length === 0) return;

      const blocks = [];
      teamCells.each((_, td) => {
        const block = extractTeamBlock($, $(td));
        if (block) blocks.push(block);
      });

      if (blocks.length < 2) return;
      if (blocks.length > 2) {
        console.warn(`[parseRoundScores] outer[${tIdx}] yielded ${blocks.length} blocks, using first 2`);
      }

      const [blockA, blockB] = blocks;
      const key = pairKey(blockA.header.teamKey, blockB.header.teamKey);
      result.set(key, {
        teamA: {
          key:     blockA.header.teamKey,
          name:    blockA.header.canonical.names[0],
          score:   blockA.header.score,
          goals:   blockA.header.goals,
          behinds: blockA.header.behinds,
          players: blockA.players,
        },
        teamB: {
          key:     blockB.header.teamKey,
          name:    blockB.header.canonical.names[0],
          score:   blockB.header.score,
          goals:   blockB.header.goals,
          behinds: blockB.header.behinds,
          players: blockB.players,
        },
      });
    } catch (e) {
      console.warn(`[parseRoundScores] Skipped outer table ${tIdx}: ${e.message}`);
    }
  });

  return result;
}

/**
 * Extract a {header, players} block from an outer team-wrapper cell.
 * Returns null if the cell doesn't contain a recognisable team table.
 *
 * Header source (in order of preference):
 *   1. <caption> of the nested team table — production layout
 *   2. Outer <td>'s own text minus the nested table — defensive fallback
 *      in case FanFooty ever moves the header out of <caption>
 *
 * Player rows: every <tr> in the nested table whose first <td> contains
 * a /player/ link. The column-labels row uses <th> not <td> so it is
 * skipped automatically. We read DT (cell 1) and SC (cell 2) only —
 * Y!/FR/GS/BL trailing columns are alternative fantasy scoring systems
 * we deliberately ignore.
 */
function extractTeamBlock($, $cell) {
  const innerTable = $cell.find('table').first();
  if (innerTable.length === 0) return null;

  let headerText = innerTable.children('caption').text().trim();
  if (!headerText) {
    const $clone = $cell.clone();
    $clone.find('table').remove();
    headerText = $clone.text().trim();
  }
  const headerInfo = parseTeamHeader(headerText);
  if (!headerInfo) return null;

  const players = [];
  innerTable.find('tr').each((_, tr) => {
    try {
      const cells = $(tr).find('td');
      if (!cells.length) return;

      const link = cells.first().find('a[href*="/player/"]');
      if (!link.length) return;

      const name = link.text().trim();
      const href = link.attr('href') || '';
      const slug = href.replace(/^.*\/player\//, '').replace(/\/$/, '');
      if (!name) return;

      const dt = parseInt(cells.eq(1).text().trim(), 10);
      const sc = parseInt(cells.eq(2).text().trim(), 10);
      if (Number.isNaN(dt) || Number.isNaN(sc)) return;

      players.push({
        id:      slug || `player_${players.length}`,
        name,
        jersey:  null,
        pos:     null,
        score:   dt,    // legacy alias for older callers
        scoreDT: dt,
        scoreSC: sc,
      });
    } catch (e) {
      // skip malformed rows silently
    }
  });

  return { header: headerInfo, players };
}

/**
 * Parse a team header string like "Brisbane: 17.17.119" or
 * "Collingwood: 15.3.93" into structured data.
 *
 * Returns { teamKey, canonical, goals, behinds, score } or null.
 */
function parseTeamHeader(text) {
  if (!text) return null;
  const m = text.match(/^([A-Za-z][A-Za-z .'\-]+?):\s*(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (!m) return null;

  const rawName = m[1].trim();
  const canonical = findTeamByAnyName(rawName);
  if (!canonical) return null;

  const goals   = parseInt(m[2], 10) || 0;
  const behinds = parseInt(m[3], 10) || 0;
  const score   = m[4] !== undefined ? parseInt(m[4], 10) : (goals * 6 + behinds);

  return { teamKey: canonical.key, canonical, goals, behinds, score };
}

// ─── FIXTURE PARSER ───────────────────────────────────────────────────────────

/**
 * Parse fixture.php and extract every game in the given round.
 *
 * Standard row layout when complete is [Day][Date][Opponents][Ground][Time].
 * Some rows omit Day and Date when they're the same as the row above —
 * we inherit from the previous game in that case.
 *
 * Round headers appear as rows whose first cell text starts with "Round N"
 * (or "Round HA", "Round P1" for preseason which we ignore by checking
 * that the round token parses as an integer).
 */
function parseFixtureRound($, targetRound) {
  const games = [];
  let currentRound = 0;
  let lastDay  = '';
  let lastDate = '';

  $('tr').each((_, row) => {
    const $row = $(row);
    const tdCells = $row.find('td');
    const thCells = $row.find('th');

    // Round header detection — try <th> first (production layout), then <td>.
    if (thCells.length > 0) {
      const firstHeaderText = $(thCells[0]).text().trim();
      const roundMatch = firstHeaderText.match(/^Round\s+(\w+)/i);
      if (roundMatch) {
        const n = parseInt(roundMatch[1], 10);
        currentRound = Number.isNaN(n) ? -1 : n;
        lastDay = ''; lastDate = '';
        return;
      }
    }
    if (tdCells.length > 0) {
      const firstCellText = $(tdCells[0]).text().trim();
      const roundMatch = firstCellText.match(/^Round\s+(\w+)/i);
      if (roundMatch) {
        const n = parseInt(roundMatch[1], 10);
        currentRound = Number.isNaN(n) ? -1 : n;
        lastDay = ''; lastDate = '';
        return;
      }
    }

    if (!tdCells.length) return;
    const cells = tdCells;

    if (currentRound !== targetRound) return;

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

      let dayText  = '';
      let dateText = '';
      if (vsIdx >= 2) {
        dayText  = $(cells[vsIdx - 2]).text().trim();
        dateText = $(cells[vsIdx - 1]).text().trim();
      } else if (vsIdx === 1) {
        dateText = $(cells[0]).text().trim();
      }

      if (!dayText)  dayText  = lastDay;
      if (!dateText) dateText = lastDate;
      if (dayText)   lastDay  = dayText;
      if (dateText)  lastDate = dateText;

      const venue = cells.length > vsIdx + 1 ? $(cells[vsIdx + 1]).text().trim() : '';
      const time  = cells.length > vsIdx + 2 ? $(cells[vsIdx + 2]).text().trim() : '';

      games.push({
        teamAKey: teamA.key,
        teamBKey: teamB.key,
        teamAName: teamA.names[0],
        teamBName: teamB.names[0],
        teamAAbbr: teamA.abbr,
        teamBAbbr: teamB.abbr,
        teamAColor: teamA.color,
        teamBColor: teamB.color,
        date: [dayText, dateText].filter(Boolean).join(' ').trim(),
        time,
        venue,
        kickoffMs: parseKickoffMs(dayText, dateText, time),
      });
    } catch (e) {
      console.warn('[parseFixtureRound] Skipped row:', e.message);
    }
  });

  return games;
}

// ─── MERGE ────────────────────────────────────────────────────────────────────

function mergeGames(fixtureGames, playersByPair, homepageGames) {
  return fixtureGames.map((fx, i) => {
    const key = pairKey(fx.teamAKey, fx.teamBKey);
    const score = playersByPair.get(key);
    const home  = homepageGames.get(key);

    let teamAScore = 0, teamAGoals = 0, teamABehinds = 0, teamAPlayers = [];
    let teamBScore = 0, teamBGoals = 0, teamBBehinds = 0, teamBPlayers = [];

    if (score) {
      if (score.teamA.key === fx.teamAKey) {
        ({ score: teamAScore, goals: teamAGoals, behinds: teamABehinds, players: teamAPlayers } = score.teamA);
        ({ score: teamBScore, goals: teamBGoals, behinds: teamBBehinds, players: teamBPlayers } = score.teamB);
      } else {
        ({ score: teamAScore, goals: teamAGoals, behinds: teamABehinds, players: teamAPlayers } = score.teamB);
        ({ score: teamBScore, goals: teamBGoals, behinds: teamBBehinds, players: teamBPlayers } = score.teamA);
      }
    } else if (home && home.scoreA !== null) {
      if (home.teamAKey === fx.teamAKey) {
        teamAScore = home.scoreA;
        teamBScore = home.scoreB;
      } else {
        teamAScore = home.scoreB;
        teamBScore = home.scoreA;
      }
    }

    const fanfootyId = home ? home.fanfootyId : null;
    const id = fanfootyId ? `ff_${fanfootyId}` : `fx_${i}`;

    return {
      id,
      fanfootyId,
      liveUrl: home ? home.liveUrl : null,
      teamA: {
        name: fx.teamAName, abbr: fx.teamAAbbr, color: fx.teamAColor,
        score: teamAScore, goals: teamAGoals, behinds: teamABehinds,
      },
      teamB: {
        name: fx.teamBName, abbr: fx.teamBAbbr, color: fx.teamBColor,
        score: teamBScore, goals: teamBGoals, behinds: teamBBehinds,
      },
      quarter:       null,
      timeRemaining: null,
      venue:         fx.venue,
      date:          fx.date,
      time:          fx.time ? `${fx.time} AET` : null,
      status:        null,
      _kickoffMs:    fx.kickoffMs,
      _hasScores:    !!score || !!(home && home.scoreA !== null),
      players:       [...teamAPlayers, ...teamBPlayers],
    };
  });
}

// ─── CLASSIFY ─────────────────────────────────────────────────────────────────

function classifyGames(games, now) {
  const liveGames = [];
  const upcomingGames = [];
  const pastGames = [];
  const nowMs = now.getTime();

  for (const game of games) {
    const k = game._kickoffMs;
    let bucket;

    if (k === null || k === undefined) {
      bucket = game._hasScores ? 'past' : 'upcoming';
    } else if (k > nowMs) {
      bucket = 'upcoming';
    } else if (nowMs <= k + LIVE_WINDOW_MS) {
      bucket = 'live';
    } else {
      bucket = 'past';
    }

    delete game._kickoffMs;
    delete game._hasScores;

    if (bucket === 'live') {
      game.status = 'live';
      liveGames.push(game);
    } else if (bucket === 'upcoming') {
      game.status = 'upcoming';
      upcomingGames.push(game);
    } else {
      game.status = 'final';
      game.quarter = 4;
      game.timeRemaining = '0:00';
      pastGames.push(game);
    }
  }

  return { liveGames, upcomingGames, pastGames };
}

// ─── DATE PARSING (Melbourne time) ────────────────────────────────────────────

function parseKickoffMs(dayText, dateText, timeText) {
  if (!dateText || !timeText) return null;

  const cleanDate = dateText.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+/i, '').trim();

  const dm = cleanDate.match(/(?:([A-Za-z]+)\s+(\d{1,2}))|(?:(\d{1,2})\s+([A-Za-z]+))/);
  if (!dm) return null;

  const monthStr = (dm[1] || dm[4] || '').toLowerCase();
  const day      = parseInt(dm[2] || dm[3], 10);
  const monthIdx = MONTHS.findIndex(m => m.startsWith(monthStr.slice(0, 3)));
  if (monthIdx === -1 || !day) return null;

  const tm = timeText.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!tm) return null;
  let hour  = parseInt(tm[1], 10);
  const min = parseInt(tm[2], 10);
  const mer = (tm[3] || '').toLowerCase();
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  if (!mer && hour < 11) hour += 12;

  const melbNow = nowInMelbourne();
  let candidate = melbourneDateToUtcMs(melbNow.year, monthIdx, day, hour, min);
  if (candidate === null) return null;

  if ((Date.now() - candidate) > 30 * 24 * 60 * 60 * 1000) {
    candidate = melbourneDateToUtcMs(melbNow.year + 1, monthIdx, day, hour, min);
  }
  return candidate;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

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

function melbourneDateToUtcMs(year, monthIdx, day, hour, min) {
  let utcGuess = Date.UTC(year, monthIdx, day, hour, min, 0);
  const offsetMin = melbourneOffsetMinutesAt(utcGuess);
  if (offsetMin === null) return null;
  let result = utcGuess - offsetMin * 60 * 1000;

  const refinedOffset = melbourneOffsetMinutesAt(result);
  if (refinedOffset !== null && refinedOffset !== offsetMin) {
    result = utcGuess - refinedOffset * 60 * 1000;
  }
  return result;
}

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

function findTeamByAnyName(input) {
  if (!input) return null;
  const needle = input.trim().toLowerCase();
  for (const team of TEAMS) {
    for (const n of team.names) {
      if (n.toLowerCase() === needle) return team;
    }
  }
  for (const team of TEAMS) {
    if (needle.includes(team.names[0].toLowerCase())) return team;
  }
  return null;
}

function pairKey(a, b) {
  return [a, b].sort().join('__');
}