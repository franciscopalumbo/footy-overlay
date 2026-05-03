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
 * ─────────────────────────────────────────────────────────────
 * ARCHITECTURE — verified against live Round 8 data on 2 May 2026:
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
 *   Each game is rendered as its OWN <table>, NOT as rows-after-header
 *   inside one shared table. Inside each game's table, every cell is in
 *   one logical block — cells flow as:
 *
 *     [TeamA: G.B.T] [Player] [DT] [SC] [Y!] [FR] [GS] [blank]
 *     [name link] [dt] [sc] [y!] [fr] [gs] [blank]
 *     [name link] [dt] [sc] [y!] [fr] [gs] [blank]
 *     ... more team A players ...
 *     [&nbsp;]
 *     [TeamB: G.B.T] [Player] [DT] [SC] [Y!] [FR] [GS] [blank]
 *     [name link] [dt] [sc] [y!] [fr] [gs] [blank]
 *     ... more team B players ...
 *
 *   We parse cell-by-cell within each <table>, anchoring on team-header
 *   cells (regex match on text) and reading the 5 numeric cells after each
 *   player name link. We do NOT depend on <tr> structure.
 *
 *   HOMEPAGE renders the current round as a list of <a> elements pointing
 *   to /live/{year}/{id}-{slug}.html. Link text contains kickoff datetime,
 *   two abbreviations on separate lines, and (for completed/in-progress
 *   games) two scores. We use this to recover FanFooty's canonical numeric
 *   game IDs and the official /live/ URLs.
 *
 *   The matchcentre at /live/{year}/{id}-{slug}.html is JS-rendered. We
 *   do NOT scrape it. quarter, timeRemaining, jersey, position, and raw
 *   stats stay null. Layer 2 (planned) will hit the underlying JSON
 *   polling endpoint once we capture it from a live game with DevTools.
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
        mockPlayer('dustin-martin', 'Dustin Martin', 'MID',  88,  91),
        mockPlayer('nick-daicos',   'Nick Daicos',   'MID', 118, 124),
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
        mockPlayer('clayton-oliver', 'Clayton Oliver', 'MID', 134, 142),
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

function emptyStats() {
  return {
    kk: null, hb: null, mk: null, tk: null, ho: null, fk: null,
    gb: null, mg: null, cp: null, cl: null,
    effPct: null, togPct: null,
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

    if (process.env.FANFOOTY_DEBUG === 'true') {
      dumpDiagnostics(
        { roundScoresHtml, fixtureHtml, homepageHtml },
        { $scores, $fixture, $home },
      );
    }

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

// ─── DIAGNOSTICS (only runs when FANFOOTY_DEBUG=true) ─────────────────────────

/**
 * Emit structural information about the three fetched pages so we can
 * trace parser behaviour from Netlify logs without re-fetching live HTML.
 *
 * Output is prefixed with "[DEBUG]" so it can be grep'd. Designed for
 * volume — produces ~100 log lines and should be left OFF in normal
 * operation.
 *
 * What's reported per page:
 *   · response byte length (sanity check: are we getting full HTML?)
 *   · first 500 characters of HTML (sanity check: HTML or error page?)
 *   · table count, td count, tr count, anchor count
 *   · title text and what parseRoundNumber sees
 *
 * What's reported for roundscores specifically:
 *   · per-table cell counts (helps spot empty tables vs game tables)
 *   · first 30 td texts of each table that has ≥7 cells (game candidates)
 *   · which cells match the team-header regex (and what text they had)
 *   · count of <a href*="/player/"> elements
 *
 * What's reported for fixture specifically:
 *   · per-tr first-cell text for the first 80 rows (so we see all round
 *     headers and the first ~70 game rows)
 *   · count of cells containing " vs "
 */
function dumpDiagnostics(htmls, parsers) {
  const { roundScoresHtml, fixtureHtml, homepageHtml } = htmls;
  const { $scores, $fixture, $home } = parsers;

  console.log('[DEBUG] ===== begin diagnostics =====');

  // ── Per-page sanity ──────────────────────────────────────────────────────
  for (const [label, html, $] of [
    ['roundscores', roundScoresHtml, $scores],
    ['fixture',    fixtureHtml,     $fixture],
    ['homepage',   homepageHtml,    $home],
  ]) {
    console.log(`[DEBUG] ${label}: ${html.length} bytes`);
    // First 500 chars, with newlines collapsed for log readability
    const head = html.slice(0, 500).replace(/\s+/g, ' ');
    console.log(`[DEBUG] ${label} head: ${head}`);
    console.log(
      `[DEBUG] ${label} counts: ` +
      `tables=${$('table').length} ` +
      `trs=${$('tr').length} ` +
      `tds=${$('td').length} ` +
      `anchors=${$('a').length} ` +
      `playerLinks=${$('a[href*="/player/"]').length} ` +
      `liveLinks=${$('a[href*="/live/"]').length}`,
    );
    const title = $('title').text().trim();
    console.log(`[DEBUG] ${label} title: "${title}"`);
  }

  // ── Roundscores: per-table inspection ────────────────────────────────────
  console.log('[DEBUG] --- roundscores tables ---');
  const outerTables = $scores('table').filter((_, t) => $scores(t).parents('table').length === 0);
  console.log(`[DEBUG] outer tables (no <table> ancestor): ${outerTables.length}`);

  outerTables.each((tIdx, table) => {
    const $table = $scores(table);
    const teamCells = $table.children('tbody').children('tr').children('td')
      .add($table.children('tr').children('td'));
    console.log(`[DEBUG] outer[${tIdx}]: ${teamCells.length} direct team cells`);

    teamCells.each((cIdx, td) => {
      const $td = $scores(td);
      const ownText = $td.clone().children().remove().end().text().trim();
      const innerTable = $td.find('table').first();
      const innerRows = innerTable.find('tr');
      const innerPlayerLinks = innerTable.find('a[href*="/player/"]').length;
      const firstRowText = innerRows.eq(0).text().trim().replace(/\s+/g, ' ').slice(0, 60);
      const firstRowThText = innerRows.eq(0).find('th').first().text().trim().slice(0, 60);
      console.log(
        `[DEBUG] outer[${tIdx}].cell[${cIdx}] ` +
        `ownText="${ownText.slice(0, 50)}" ` +
        `innerRows=${innerRows.length} innerPlayerLinks=${innerPlayerLinks} ` +
        `firstRow="${firstRowText}" firstRowTh="${firstRowThText}"`,
      );
    });
  });

  // Also dump all $('table') cell counts for completeness — distinguishes
  // outer game tables from inner player tables.
  $scores('table').each((tIdx, table) => {
    const cells = $scores(table).find('td');
    console.log(`[DEBUG] table[${tIdx}]: ${cells.length} total cells (find), depth=${$scores(table).parents('table').length}`);
  });

  // ── Fixture: per-row inspection ──────────────────────────────────────────
  console.log('[DEBUG] --- fixture rows (first 80) ---');
  $fixture('tr').slice(0, 80).each((rIdx, row) => {
    const cells = $fixture(row).find('td');
    const firstText = cells.length ? $fixture(cells[0]).text().trim().slice(0, 30) : '<no cells>';
    const vsCount = cells.filter((_, c) => $fixture(c).text().includes(' vs ')).length;
    console.log(`[DEBUG] tr[${rIdx}]: ${cells.length} cells, first="${firstText}"${vsCount ? ' VS' : ''}`);
  });
  const totalVs = $fixture('td').filter((_, c) => $fixture(c).text().includes(' vs ')).length;
  console.log(`[DEBUG] fixture: ${totalVs} cells contain " vs " total`);

  // ── Critical probe: what extractTeamBlock actually sees ──────────────────
  // Dumps the raw text that parseTeamHeader will be called with for the
  // first non-spacer cell of each outer table. This directly shows whether
  // "Collingwood: 15.3.93" is present after removing the inner table.
  console.log('[DEBUG] --- extractTeamBlock input probe ---');
  const outerProbe = $scores('table').filter((_, t) => $scores(t).parents('table').length === 0);
  outerProbe.each((tIdx, table) => {
    const cells = $scores(table).children('tbody').children('tr').children('td')
      .add($scores(table).children('tr').children('td'));
    cells.each((cIdx, td) => {
      const $td = $scores(td);
      // Reproduce exactly what extractTeamBlock does
      const $clone = $td.clone();
      $clone.find('table').remove();
      const fullTextMinusTable = $clone.text().trim();
      if (fullTextMinusTable) { // only log non-empty cells
        console.log(`[DEBUG] probe outer[${tIdx}].cell[${cIdx}] fullTextMinusTable="${fullTextMinusTable.slice(0, 80)}"`);
      }
    });
  });

  // ── Homepage: live link inspection ───────────────────────────────────────
  console.log('[DEBUG] --- homepage live links (first 5) ---');
  $home('a[href*="/live/"]').slice(0, 5).each((idx, el) => {
    const $a = $home(el);
    const href = $a.attr('href') || '';
    const text = $a.text().replace(/\s+/g, ' ').trim().slice(0, 80);
    console.log(`[DEBUG] live[${idx}] href="${href}" text="${text}"`);
  });

  console.log('[DEBUG] ===== end diagnostics =====');
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
 * VERIFIED PRODUCTION HTML STRUCTURE (from diagnostic logs, 2 May 2026):
 *   Each game is rendered as one OUTER <table> containing one <tr> with
 *   THREE direct <td> cells: [teamA wrapper][spacer][teamB wrapper].
 *   Each team-wrapper cell contains an INNER <table> whose FIRST row is
 *   the team header (a single <th> spanning all columns, containing text
 *   like "Collingwood: 15.3.93") and whose subsequent rows are player
 *   rows with <td> cells for name+scores.
 *
 *     <table>                                <-- outer game table
 *       <tr>
 *         <td>                               <-- cell[0] = team A wrapper
 *           <table>                          <-- inner team A table
 *             <tr><th colspan="6">Collingwood: 15.3.93</th></tr>  <-- header
 *             <tr><td><a href="...">Nick Daicos</a></td>
 *                 <td>124</td><td>103</td>...</tr>                <-- player
 *             ...
 *           </table>
 *         </td>
 *         <td>&nbsp;</td>                    <-- cell[1] = spacer
 *         <td>                               <-- cell[2] = team B wrapper
 *           <table>...</table>
 *         </td>
 *       </tr>
 *     </table>
 *
 *   Diagnostic confirmed: 3 outer tables (3 games), each with 3 direct
 *   team cells. cell[0] and cell[2] each have innerRows=24 with 23 player
 *   links — the 24th row being the header. cell[1] has innerRows=0.
 *
 * Algorithm:
 *   1. Walk OUTER tables — those with no <table> ancestor.
 *   2. Get direct child cells of the outer table's row.
 *   3. For each non-empty cell (skip spacer at cell[1]), find the FIRST
 *      <table> inside, extract:
 *        · header text from the first <tr> — try <th> first, fall back
 *          to .text() of the entire first row
 *        · players from subsequent <tr>s containing /player/ links
 *   4. Pair the two teams found per outer table — that's one game.
 */
function parseRoundScores($) {
  const result = new Map();

  const outerTables = $('table').filter((_, t) => $(t).parents('table').length === 0);

  outerTables.each((tIdx, table) => {
    try {
      // Get direct cells of the outer row. cheerio (slim/htmlparser2) does
      // NOT auto-inject <tbody>, so .children('tr') is reliable; we also
      // try the <tbody> path defensively in case parse5 or future versions
      // add it.
      const $table = $(table);
      let teamCells = $table.children('tbody').children('tr').children('td');
      if (teamCells.length === 0) {
        teamCells = $table.children('tr').children('td');
      }
      if (teamCells.length === 0) return;

      // Extract a (header, players) block from each cell that contains
      // a nested table. Cells that are empty or are pure spacers yield null.
      const blocks = [];
      teamCells.each((cIdx, td) => {
        const block = extractTeamBlock($, $(td));
        if (process.env.FANFOOTY_DEBUG === 'true') {
          if (block) {
            console.log(
              `[DEBUG] extract outer[${tIdx}].cell[${cIdx}] → ${block.header.canonical.names[0]} ` +
              `${block.header.goals}.${block.header.behinds}.${block.header.score}, ` +
              `${block.players.length} players`,
            );
          } else {
            // Tell us what was in the cell that we rejected
            const innerTable = $(td).find('table').first();
            const rowCount = innerTable.find('tr').length;
            const linkCount = innerTable.find('a[href*="/player/"]').length;
            const firstRowText = innerTable.find('tr').eq(0).text().trim().replace(/\s+/g, ' ').slice(0, 80);
            console.log(
              `[DEBUG] extract outer[${tIdx}].cell[${cIdx}] → null ` +
              `(rows=${rowCount}, links=${linkCount}, firstRow="${firstRowText}")`,
            );
          }
        }
        if (block) blocks.push(block);
      });

      if (blocks.length < 2) return;

      // Pair the first two team blocks. If a layout ever produces more
      // than 2 (unlikely), we still take the first pair as the game and
      // log the leftover for diagnosis.
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
 * VERIFIED PRODUCTION STRUCTURE (from diagnostic logs, 3 May 2026):
 *   The team header text ("Collingwood: 15.3.93") lives OUTSIDE the nested
 *   player table, as a sibling element (likely <b>, <div>, or <a>) before
 *   the inner <table>. The outer cell's own text is empty, and the inner
 *   table's first row is the column-labels row ("Player DT SC Y! FR GS"),
 *   not the team header.
 *
 *   Evidence from logs:
 *     ownText=""             → header not a bare text node in outer <td>
 *     firstRow="PlayerDTSC" → header not inside the nested table
 *     innerPlayerLinks=23   → inner table has only player rows
 *
 *   Extraction: clone the outer <td>, remove the inner <table>, call
 *   .text() on what remains. This yields the header text regardless of
 *   which wrapper element FanFooty uses (<b>/<div>/<a>/etc).
 *
 *   Player rows: inside the inner <table>, every <tr> whose first <td>
 *   contains a /player/ link. Column-labels rows have <th> not <td> so
 *   `find('td')` returns 0 and they're skipped automatically.
 */
function extractTeamBlock($, $cell) {
  const innerTable = $cell.find('table').first();
  if (innerTable.length === 0) return null;

  // ── Team header: outer cell text minus the inner table ───────────────────
  const $clone = $cell.clone();
  $clone.find('table').remove();
  const headerText = $clone.text().trim();
  const headerInfo = parseTeamHeader(headerText);
  if (!headerInfo) return null;

  // ── Players: all <tr>s in the inner table that have a /player/ link ──────
  const players = [];
  innerTable.find('tr').each((_, tr) => {
    try {
      const cells = $(tr).find('td');
      if (!cells.length) return; // <th> header row — skip

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
        jersey:  null,
        name,
        pos:     null,
        score:   dt,
        scoreDT: dt,
        scoreSC: sc,
        stats:   emptyStats(),
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
 * Permissive on input: the team-name + score pattern can appear anywhere
 * in the text (no `$` anchor) so trailing whitespace, newlines, status
 * badges ("FINAL"), or column labels concatenated by .text() recursion
 * don't break the match. We anchor to `^` so we still match the team
 * name from the START of the text — preventing player-row text from
 * accidentally matching when concatenated.
 *
 * Returns { teamKey, canonical, goals, behinds, score } or null.
 */
function parseTeamHeader(text) {
  if (!text) return null;
  // Match leading "Name: G.B" or "Name: G.B.T", allowing trailing content
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
 * VERIFIED PRODUCTION STRUCTURE: One <table> with ~269 <tr>s. Standard
 * row layout when complete is [Day][Date][Opponents][Ground][Time]. Some
 * rows omit Day and Date when they're the same as the row above —
 * inheriting from the previous game.
 *
 * Round headers appear as rows whose first cell text starts with "Round N"
 * (or "Round HA", "Round P1" for preseason/HA which we ignore by checking
 * that the round token parses as an integer).
 *
 * Strategy:
 *   · Walk every <tr> in the document
 *   · If the row's first cell starts with "Round N", set currentRound = N
 *   · Otherwise, look for a cell containing " vs " — that's a game row
 *   · Day and date cells are at vsIdx-2 and vsIdx-1 respectively;
 *     venue at vsIdx+1, time at vsIdx+2. Use last-seen values for
 *     blank day/date cells (consecutive same-day games).
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

    // Round header detection: FanFooty's production HTML renders round
    // headers using <th> ("Round 8"). Some pages may use <td>. Check both.
    // Try <th> first; fall back to <td>.
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

    // Game row: must have <td>s (game rows always use <td>, not <th>)
    if (!tdCells.length) return;
    const cells = tdCells;

    if (currentRound !== targetRound) return;

    // Find the cell containing " vs " — that's the game opponents cell.
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

      // Day/date: usually at vsIdx-2 and vsIdx-1. If those cells are
      // blank, inherit from the most recent non-blank values.
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