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
  $scores('table').each((tIdx, table) => {
    const cells = $scores(table).find('td');
    if (cells.length < 7) {
      console.log(`[DEBUG] table[${tIdx}]: ${cells.length} cells (skipped — too few)`);
      return;
    }
    console.log(`[DEBUG] table[${tIdx}]: ${cells.length} cells`);

    // First 30 cell texts (truncated)
    const samples = [];
    cells.slice(0, 30).each((cIdx, cell) => {
      const text = $scores(cell).text().trim().slice(0, 40);
      const hasLink = $scores(cell).find('a').length > 0;
      samples.push(`  [${cIdx}]${hasLink ? '🔗' : '  '}"${text}"`);
    });
    console.log(`[DEBUG] table[${tIdx}] first 30 cells:\n${samples.join('\n')}`);

    // Find cells matching team-header regex
    const headerMatches = [];
    cells.each((cIdx, cell) => {
      const $cell = $scores(cell);
      if ($cell.find('a').length > 0) return;
      const text = $cell.text().trim();
      // Don't use parseTeamHeader (which requires a known team) here —
      // just check if the SHAPE matches, so we can see whether the regex
      // fails or only the team-name resolution fails.
      if (/^.+:\s*\d+\.\d+(\.\d+)?$/.test(text)) {
        headerMatches.push(`[${cIdx}] "${text}"`);
      }
    });
    console.log(`[DEBUG] table[${tIdx}] team-header regex matches: ${headerMatches.length}`);
    if (headerMatches.length > 0 && headerMatches.length < 10) {
      headerMatches.forEach(m => console.log(`[DEBUG]   ${m}`));
    }
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

function parseRoundScores($) {
  const result = new Map();

  $('table').each((_, table) => {
    try {
      const cells = $(table).find('td');
      if (cells.length < 7) return;

      const blocks = [];
      let currentStart = -1;
      let currentHeader = null;

      cells.each((idx, cell) => {
        const $cell = $(cell);
        if ($cell.find('a').length > 0) return;
        const text = $cell.text().trim();
        const headerInfo = parseTeamHeader(text);
        if (headerInfo) {
          if (currentStart >= 0 && currentHeader) {
            blocks.push({ header: currentHeader, start: currentStart, end: idx });
          }
          currentHeader = headerInfo;
          currentStart = idx;
        }
      });
      if (currentStart >= 0 && currentHeader) {
        blocks.push({ header: currentHeader, start: currentStart, end: cells.length });
      }

      // Accept any even number of blocks, paired in order. This covers:
      //   · 0 blocks (skip)
      //   · 2 blocks (typical: one game per table)
      //   · 4, 6, 8, ... blocks (production may put multiple games per table)
      // Odd numbers indicate a parse problem; we still process pairs and
      // drop the trailing unpaired block.
      if (blocks.length < 2) return;

      for (let pairIdx = 0; pairIdx + 1 < blocks.length; pairIdx += 2) {
        const blockA = blocks[pairIdx];
        const blockB = blocks[pairIdx + 1];
        const playersA = collectPlayersInRange($, cells, blockA.start, blockA.end);
        const playersB = collectPlayersInRange($, cells, blockB.start, blockB.end);

        const key = pairKey(blockA.header.teamKey, blockB.header.teamKey);
        result.set(key, {
          teamA: {
            key:     blockA.header.teamKey,
            name:    blockA.header.canonical.names[0],
            score:   blockA.header.score,
            goals:   blockA.header.goals,
            behinds: blockA.header.behinds,
            players: playersA,
          },
          teamB: {
            key:     blockB.header.teamKey,
            name:    blockB.header.canonical.names[0],
            score:   blockB.header.score,
            goals:   blockB.header.goals,
            behinds: blockB.header.behinds,
            players: playersB,
          },
        });
      }
    } catch (e) {
      console.warn(`[parseRoundScores] Skipped a table: ${e.message}`);
    }
  });

  return result;
}

function parseTeamHeader(text) {
  const m = text.match(/^(.+?):\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;

  const rawName = m[1].trim();
  const canonical = findTeamByAnyName(rawName);
  if (!canonical) return null;

  const goals   = parseInt(m[2], 10) || 0;
  const behinds = parseInt(m[3], 10) || 0;
  const score   = m[4] !== undefined ? parseInt(m[4], 10) : (goals * 6 + behinds);

  return { teamKey: canonical.key, canonical, goals, behinds, score };
}

function collectPlayersInRange($, cells, start, end) {
  const players = [];

  for (let i = start; i < end; i++) {
    const $cell = $(cells[i]);
    const link = $cell.find('a[href*="/player/"]');
    if (!link.length) continue;

    try {
      const name = link.text().trim();
      const href = link.attr('href') || '';
      const slug = href.replace(/^.*\/player\//, '').replace(/\/$/, '');
      if (!name) continue;

      const dtText = $(cells[i + 1]).text().trim();
      const scText = $(cells[i + 2]).text().trim();
      const dt = parseInt(dtText, 10);
      const sc = parseInt(scText, 10);

      if (Number.isNaN(dt) || Number.isNaN(sc)) continue;

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
      // skip
    }
  }

  return players;
}

// ─── FIXTURE PARSER ───────────────────────────────────────────────────────────

/**
 * Parse fixture.php and extract every game in the given round.
 *
 * IMPLEMENTATION NOTE — DEFENSIVE AGAINST MALFORMED HTML:
 *   FanFooty's pages are PHP-generated and may emit `<td>` directly inside
 *   `<table>` without `<tr>` wrappers. cheerio (parse5) preserves these
 *   foster-parented cells but they're not visible to `$('tr').each()`.
 *
 *   So we walk the flat cell sequence (all <td> in document order) and
 *   reconstruct logical rows by anchoring on cells containing " vs ".
 *   For each `vs` cell at index i, we look at:
 *     · cells[i-2] = day name (e.g. "Saturday") or blank
 *     · cells[i-1] = date (e.g. "April 30") or blank — inherit from
 *                    most recent non-blank if blank
 *     · cells[i+1] = venue
 *     · cells[i+2] = time
 *   "Round N" header cells, found by a regex on cell text, set the
 *   currentRound that subsequent vs cells belong to.
 */
function parseFixtureRound($, targetRound) {
  const games = [];

  // Get every <td> in document order, regardless of <tr> structure
  const allCells = $('td').toArray();
  if (!allCells.length) return games;

  let currentRound = 0;
  let lastDay  = '';
  let lastDate = '';

  for (let i = 0; i < allCells.length; i++) {
    const text = $(allCells[i]).text().trim();

    // Round header detection — be liberal about what comes after "Round"
    // since FanFooty has both numeric (Round 1, Round 8) and prefixed
    // (Round HA, Round P1) variants. We only consider numeric ones in scope.
    const roundMatch = text.match(/^Round\s+(\w+)\b/i);
    if (roundMatch) {
      const n = parseInt(roundMatch[1], 10);
      currentRound = Number.isNaN(n) ? -1 : n;
      // New round means we shouldn't carry over date inheritance
      lastDay = ''; lastDate = '';
      continue;
    }

    // Skip non-vs cells
    if (!text.includes(' vs ')) continue;

    // We've found a game cell. Only process if we're in the target round.
    if (currentRound !== targetRound) continue;

    try {
      const vsParts = text.split(/\s+vs\s+/);
      if (vsParts.length < 2) continue;

      const teamA = findTeamByAnyName(vsParts[0].trim());
      const teamB = findTeamByAnyName(vsParts[1].trim());
      if (!teamA || !teamB) continue;

      // Look at neighbouring cells. These offsets assume the standard
      // FanFooty fixture layout: [day][date][opponents][ground][time]
      const dayCell  = i >= 2 ? $(allCells[i - 2]).text().trim() : '';
      const dateCell = i >= 1 ? $(allCells[i - 1]).text().trim() : '';
      const venue = i + 1 < allCells.length ? $(allCells[i + 1]).text().trim() : '';
      const time  = i + 2 < allCells.length ? $(allCells[i + 2]).text().trim() : '';

      // Day/date inheritance: if blank, reuse last non-blank values.
      // BUT only inherit if the cell is genuinely blank — not if it contains
      // some other text we don't recognize.
      let dayText = dayCell || lastDay;
      let dateText = dateCell || lastDate;

      // Only update inheritance vars when we got real day/date (not when
      // the dayCell was the previous game's venue or some other artifact).
      // Heuristic: a day cell looks like "Monday".."Sunday"; a date cell
      // looks like "Month NN" or "NN Month".
      if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(dayCell)) lastDay = dayCell;
      if (/^[A-Za-z]+\s+\d{1,2}$|^\d{1,2}\s+[A-Za-z]+$/.test(dateCell)) lastDate = dateCell;

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
      console.warn('[parseFixtureRound] Skipped a vs cell:', e.message);
    }
  }

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