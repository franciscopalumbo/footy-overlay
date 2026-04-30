/**
 * FootyOverlay — Jersey Lookup Netlify Function
 * File: /netlify/functions/jersey-lookup.js
 *
 * PURPOSE:
 *   Accepts a comma-separated list of player names and returns each
 *   player's current jersey number and club, scraped from AFL.com.au
 *   squad lists. Used to populate the # column in the My Team tab.
 *
 * ENDPOINT (via netlify.toml redirect): GET /api/jersey-lookup
 *
 * QUERY PARAMS:
 *   names  — URL-encoded, comma-separated player names
 *            e.g. ?names=Patrick+Dangerfield,Marcus+Bontempelli
 *
 * RESPONSE:
 *   Array of resolved player records:
 *   [
 *     { "name": "Patrick Dangerfield", "jersey": 35, "team": "Geelong" },
 *     { "name": "Unknown Player",      "jersey": null, "team": null },
 *     ...
 *   ]
 *   Players not found are included with jersey: null, team: null
 *   so the front-end knows to show '?' rather than a spinner.
 *
 * FALLBACK:
 *   If scraping fails, or JERSEY_MOCK=true env var is set, the function
 *   returns results from the JERSEY_FALLBACK hardcoded map below.
 *
 * DEPENDENCIES:
 *   npm install node-fetch cheerio
 *   (same deps as fanfooty-proxy — already in package.json if installed)
 *
 * ============================================================
 * SCRAPING NOTES:
 *
 * The AFL website publishes squad lists per club. Each list page
 * contains player names with their guernsey (jersey) numbers.
 *
 * Key URLs:
 *   Squad list index:  https://www.afl.com.au/teams
 *   Per-club squads:   https://www.afl.com.au/teams/{club-slug}/players
 *   e.g. Geelong:      https://www.afl.com.au/teams/geelong-cats/players
 *
 * Alternative — FanFooty player search:
 *   https://www.fanfooty.com.au/player/{player-id}/
 *   (requires knowing FanFooty player IDs — harder to cross-reference by name)
 *
 * Strategy used here: build a full name→jersey map by scraping ALL
 * club squad pages once, caching the result for the function's lifetime
 * (Lambda warm cache — persists across requests in the same execution
 * environment, typically several minutes on Netlify). On cache miss or
 * cold start, re-scrape all clubs. This keeps per-request latency low.
 * ============================================================
 */

// const fetch   = require('node-fetch');  // Node 16 and below — uncomment if needed
// const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// CLUB SLUG MAP
// Maps AFL club display names to their slug on afl.com.au/teams/{slug}/players
// Update if the AFL website changes URLs or a club rebrands.
// ---------------------------------------------------------------------------
const CLUB_SLUGS = {
  'Adelaide':         'adelaide-crows',
  'Brisbane Lions':   'brisbane-lions',
  'Carlton':          'carlton-blues',
  'Collingwood':      'collingwood-magpies',
  'Essendon':         'essendon-bombers',
  'Fremantle':        'fremantle-dockers',
  'Geelong':          'geelong-cats',
  'Gold Coast':       'gold-coast-suns',
  'GWS Giants':       'gws-giants',
  'Hawthorn':         'hawthorn-hawks',
  'Melbourne':        'melbourne-demons',
  'North Melbourne':  'north-melbourne-kangaroos',
  'Port Adelaide':    'port-adelaide-power',
  'Richmond':         'richmond-tigers',
  'St Kilda':         'st-kilda-saints',
  'Sydney':           'sydney-swans',
  'West Coast':       'west-coast-eagles',
  'Western Bulldogs': 'western-bulldogs',
};

// ---------------------------------------------------------------------------
// JERSEY FALLBACK MAP
// ⚠️  NEEDS ANNUAL UPDATE before each AFL season (squad numbers change).
// Only used when scraping fails. Keep in sync with the front-end's own
// JERSEY_FALLBACK constant in index.html.
//
// Format: 'Full Player Name': { jersey: N, team: 'Club Name' }
// ---------------------------------------------------------------------------
const JERSEY_FALLBACK = {
  // ── Geelong ──────────────────────────────────────────────
  'Patrick Dangerfield':    { jersey: 35, team: 'Geelong' },
  'Tom Hawkins':            { jersey: 26, team: 'Geelong' },
  'Jeremy Cameron':         { jersey: 5,  team: 'Geelong' },
  'Mark Blicavs':           { jersey: 22, team: 'Geelong' },
  'Isaac Smith':            { jersey: 8,  team: 'Geelong' },
  'Mitch Duncan':           { jersey: 22, team: 'Geelong' },
  'Tyson Stengle':          { jersey: 2,  team: 'Geelong' },
  // ── Western Bulldogs ─────────────────────────────────────
  'Marcus Bontempelli':     { jersey: 4,  team: 'Western Bulldogs' },
  'Adam Treloar':           { jersey: 8,  team: 'Western Bulldogs' },
  'Bailey Smith':           { jersey: 9,  team: 'Western Bulldogs' },
  'Tom Liberatore':         { jersey: 7,  team: 'Western Bulldogs' },
  'Cody Weightman':         { jersey: 27, team: 'Western Bulldogs' },
  // ── Brisbane Lions ───────────────────────────────────────
  'Lachlan Neale':          { jersey: 6,  team: 'Brisbane Lions' },
  'Zac Bailey':             { jersey: 2,  team: 'Brisbane Lions' },
  'Joe Daniher':            { jersey: 5,  team: 'Brisbane Lions' },
  'Charlie Cameron':        { jersey: 7,  team: 'Brisbane Lions' },
  'Dayne Zorko':            { jersey: 9,  team: 'Brisbane Lions' },
  'Lincoln McCarthy':       { jersey: 3,  team: 'Brisbane Lions' },
  // ── Melbourne ────────────────────────────────────────────
  'Clayton Oliver':         { jersey: 13, team: 'Melbourne' },
  'Christian Petracca':     { jersey: 5,  team: 'Melbourne' },
  'Max Gawn':               { jersey: 11, team: 'Melbourne' },
  'Jack Viney':             { jersey: 7,  team: 'Melbourne' },
  'Bayley Fritsch':         { jersey: 12, team: 'Melbourne' },
  'Steven May':             { jersey: 44, team: 'Melbourne' },
  // ── Collingwood ──────────────────────────────────────────
  'Nick Daicos':            { jersey: 35, team: 'Collingwood' },
  'Scott Pendlebury':       { jersey: 10, team: 'Collingwood' },
  'Jordan De Goey':         { jersey: 5,  team: 'Collingwood' },
  'Darcy Moore':            { jersey: 2,  team: 'Collingwood' },
  'Brayden Maynard':        { jersey: 21, team: 'Collingwood' },
  // ── Richmond ─────────────────────────────────────────────
  'Dustin Martin':          { jersey: 4,  team: 'Richmond' },
  'Shai Bolton':            { jersey: 12, team: 'Richmond' },
  'Jack Riewoldt':          { jersey: 8,  team: 'Richmond' },
  'Trent Cotchin':          { jersey: 9,  team: 'Richmond' },
  'Nick Vlastuin':          { jersey: 22, team: 'Richmond' },
  // ── Carlton ──────────────────────────────────────────────
  'Patrick Cripps':         { jersey: 9,  team: 'Carlton' },
  'Harry McKay':            { jersey: 1,  team: 'Carlton' },
  'Sam Walsh':              { jersey: 8,  team: 'Carlton' },
  // ── Hawthorn ─────────────────────────────────────────────
  'James Sicily':           { jersey: 8,  team: 'Hawthorn' },
  'Jai Newcombe':           { jersey: 12, team: 'Hawthorn' },
  'Dylan Moore':            { jersey: 15, team: 'Hawthorn' },
  'Mitch Lewis':            { jersey: 26, team: 'Hawthorn' },
  // ── Essendon ─────────────────────────────────────────────
  'Darcy Parish':           { jersey: 7,  team: 'Essendon' },
  'Jordan Ridley':          { jersey: 11, team: 'Essendon' },
  'Jake Stringer':          { jersey: 4,  team: 'Essendon' },
  // ── Sydney ───────────────────────────────────────────────
  'Callum Mills':           { jersey: 14, team: 'Sydney' },
  'Chad Warner':            { jersey: 31, team: 'Sydney' },
  'Isaac Heeney':           { jersey: 5,  team: 'Sydney' },
  'Errol Gulden':           { jersey: 10, team: 'Sydney' },
  // ── GWS Giants ───────────────────────────────────────────
  'Toby Greene':            { jersey: 4,  team: 'GWS Giants' },
  'Lachie Whitfield':       { jersey: 6,  team: 'GWS Giants' },
  // ── Adelaide ─────────────────────────────────────────────
  'Rory Laird':             { jersey: 22, team: 'Adelaide' },
  'Taylor Walker':          { jersey: 13, team: 'Adelaide' },
  'Ben Keays':              { jersey: 28, team: 'Adelaide' },
  'Jordan Dawson':          { jersey: 3,  team: 'Adelaide' },
  // ── Port Adelaide ────────────────────────────────────────
  'Travis Boak':            { jersey: 5,  team: 'Port Adelaide' },
  'Connor Rozee':           { jersey: 9,  team: 'Port Adelaide' },
  'Zak Butters':            { jersey: 6,  team: 'Port Adelaide' },
  'Ollie Wines':            { jersey: 23, team: 'Port Adelaide' },
  // ── Fremantle ────────────────────────────────────────────
  'Nat Fyfe':               { jersey: 6,  team: 'Fremantle' },
  'Andrew Brayshaw':        { jersey: 15, team: 'Fremantle' },
  'Caleb Serong':           { jersey: 28, team: 'Fremantle' },
  // ── West Coast ───────────────────────────────────────────
  'Tim Kelly':              { jersey: 4,  team: 'West Coast' },
  'Elliot Yeo':             { jersey: 15, team: 'West Coast' },
  // ── North Melbourne ──────────────────────────────────────
  'Jason Horne-Francis':    { jersey: 1,  team: 'North Melbourne' },
  'Luke Davies-Uniacke':    { jersey: 6,  team: 'North Melbourne' },
  'Jy Simpkin':             { jersey: 5,  team: 'North Melbourne' },
  // ── Gold Coast ───────────────────────────────────────────
  'Touk Miller':            { jersey: 4,  team: 'Gold Coast' },
  'Noah Anderson':          { jersey: 6,  team: 'Gold Coast' },
  'Matt Rowell':            { jersey: 18, team: 'Gold Coast' },
  // ── St Kilda ─────────────────────────────────────────────
  'Jack Steele':            { jersey: 4,  team: 'St Kilda' },
  'Max King':               { jersey: 7,  team: 'St Kilda' },
  'Hunter Clark':           { jersey: 12, team: 'St Kilda' },
  // ── Western Bulldogs (continued) ─────────────────────────
  'Cody Weightman':         { jersey: 27, team: 'Western Bulldogs' },
};

// ---------------------------------------------------------------------------
// WARM CACHE
// Netlify Lambda containers stay alive for several minutes between requests.
// We cache the full scraped name→{jersey,team} map here so subsequent calls
// within the same warm container skip the scrape entirely.
// ---------------------------------------------------------------------------
let _scrapeCache = null;         // Map<string, {jersey, team}> | null
let _scrapeCacheTime = 0;        // Unix ms timestamp of last scrape
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
exports.handler = async function (event, context) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  // Parse requested names from query string
  const rawNames = event.queryStringParameters?.names || '';
  if (!rawNames.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing ?names= param' }) };
  }

  const requestedNames = rawNames
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);

  // Mock mode — return from hardcoded map immediately
  if (process.env.JERSEY_MOCK === 'true') {
    console.log('[jersey-lookup] JERSEY_MOCK=true — returning fallback data');
    return { statusCode: 200, headers, body: JSON.stringify(resolveFromMap(requestedNames, JERSEY_FALLBACK)) };
  }

  // Try to build/use the scraped map
  let playerMap;
  try {
    playerMap = await getPlayerMap();
  } catch (err) {
    console.warn('[jersey-lookup] Scrape failed, using fallback:', err.message);
    playerMap = JERSEY_FALLBACK;
  }

  const results = resolveFromMap(requestedNames, playerMap);
  return { statusCode: 200, headers, body: JSON.stringify(results) };
};

// ---------------------------------------------------------------------------
// RESOLUTION HELPER
// ---------------------------------------------------------------------------
/**
 * Resolves a list of requested player names against a lookup map.
 * Tries exact match first, then case-insensitive, then normalised
 * (strips punctuation, collapses whitespace) for resilience against
 * minor name formatting differences.
 *
 * @param {string[]} names
 * @param {Object} map - { 'Full Name': { jersey, team }, ... }
 * @returns {Array} [{ name, jersey, team }, ...]
 */
function resolveFromMap(names, map) {
  // Build a normalised index for fuzzy matching
  const normalisedMap = {};
  for (const [key, val] of Object.entries(map)) {
    normalisedMap[normalise(key)] = { ...val, originalName: key };
  }

  return names.map(name => {
    // 1. Exact match
    if (map[name]) return { name, ...map[name] };
    // 2. Case-insensitive exact match
    const lower = name.toLowerCase();
    const exactLower = Object.keys(map).find(k => k.toLowerCase() === lower);
    if (exactLower) return { name, ...map[exactLower] };
    // 3. Normalised match (strips punctuation, extra spaces)
    const norm = normalise(name);
    if (normalisedMap[norm]) return { name, jersey: normalisedMap[norm].jersey, team: normalisedMap[norm].team };
    // 4. Not found
    return { name, jersey: null, team: null };
  });
}

/** Normalise a name for fuzzy comparison: lowercase, strip punctuation, collapse spaces */
function normalise(str) {
  return str.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// SCRAPING LAYER
// ---------------------------------------------------------------------------
/**
 * Returns the full player→{jersey,team} map, using the warm cache if fresh,
 * otherwise scraping all club squad pages from AFL.com.au.
 *
 * @returns {Promise<Object>} Map of player names to jersey/team data
 */
async function getPlayerMap() {
  const now = Date.now();
  if (_scrapeCache && (now - _scrapeCacheTime) < CACHE_TTL_MS) {
    console.log('[jersey-lookup] Returning cached player map');
    return _scrapeCache;
  }

  console.log('[jersey-lookup] Cache miss — scraping AFL.com.au squad pages');
  const map = await scrapeAllClubs();
  _scrapeCache = map;
  _scrapeCacheTime = now;
  return map;
}

/**
 * Scrapes all 18 AFL club squad pages concurrently and merges results
 * into a single name→{jersey,team} map.
 *
 * @returns {Promise<Object>}
 */
async function scrapeAllClubs() {
  const allEntries = {};

  // TODO: Uncomment once node-fetch and cheerio are installed.
  //
  // Scrape all clubs in parallel (Promise.allSettled so one failure
  // doesn't block the rest):
  //
  // const results = await Promise.allSettled(
  //   Object.entries(CLUB_SLUGS).map(([team, slug]) =>
  //     scrapeClubSquad(team, slug)
  //   )
  // );
  //
  // results.forEach(result => {
  //   if (result.status === 'fulfilled') {
  //     Object.assign(allEntries, result.value);
  //   } else {
  //     console.warn('[jersey-lookup] Club scrape failed:', result.reason?.message);
  //   }
  // });

  // PLACEHOLDER: Return hardcoded fallback until scraping is implemented.
  return { ...JERSEY_FALLBACK };
}

/**
 * Scrapes a single AFL club's squad page and returns a name→{jersey,team} map.
 *
 * TARGET URL: https://www.afl.com.au/teams/{slug}/players
 * e.g.        https://www.afl.com.au/teams/geelong-cats/players
 *
 * HOW TO IMPLEMENT:
 * 1. Open the URL in Chrome DevTools → inspect the player card grid.
 * 2. Each player card typically looks like:
 *      <div class="player-card" data-jumper-number="35">
 *        <span class="player-name">Patrick Dangerfield</span>
 *      </div>
 *    OR it may be a list:
 *      <tr class="list-item">
 *        <td class="jumper">35</td>
 *        <td class="name">Patrick Dangerfield</td>
 *      </tr>
 *
 * 3. Update the selectors in the TODO block below to match what you find.
 *
 * @param {string} team - Display name, e.g. 'Geelong'
 * @param {string} slug - URL slug, e.g. 'geelong-cats'
 * @returns {Promise<Object>} { 'Player Name': { jersey, team }, ... }
 */
async function scrapeClubSquad(team, slug) {
  const entries = {};

  // TODO: Uncomment and implement once node-fetch + cheerio are installed.
  //
  // const url = `https://www.afl.com.au/teams/${slug}/players`;
  // const res = await fetch(url, {
  //   headers: {
  //     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  //     'Accept': 'text/html,application/xhtml+xml',
  //     'Accept-Language': 'en-AU,en;q=0.9',
  //     'Referer': 'https://www.afl.com.au/',
  //   },
  //   timeout: 10000,
  // });
  // if (!res.ok) throw new Error(`${team}: HTTP ${res.status} from ${url}`);
  // const html = await res.text();
  // const $ = cheerio.load(html);
  //
  // ── Option A: Player card grid (most likely current AFL.com.au layout) ──
  // $('.player-card, [class*="PlayerCard"], [data-jumper-number]').each((_, el) => {
  //   const $el = $(el);
  //   // Jersey: try data attribute first, then a child element
  //   const jersey = parseInt(
  //     $el.attr('data-jumper-number') ||
  //     $el.find('[class*="jumper"], [class*="number"], [class*="guernsey"]').first().text()
  //   );
  //   // Name: look for a prominent text child — adjust selector to actual DOM
  //   const name = $el.find('[class*="name"], [class*="Name"]').first().text().trim();
  //   if (name && !isNaN(jersey)) {
  //     entries[name] = { jersey, team };
  //   }
  // });
  //
  // ── Option B: Table/list layout (older AFL.com.au or FanFooty squad pages) ──
  // $('table.squad-list tbody tr, .squad-row').each((_, row) => {
  //   const $row = $(row);
  //   const jersey = parseInt($row.find('td:first-child, .jersey-number').text().trim());
  //   const name   = $row.find('td:nth-child(2), .player-name').text().trim();
  //   if (name && !isNaN(jersey)) {
  //     entries[name] = { jersey, team };
  //   }
  // });
  //
  // ── Option C: AFL API / JSON-LD embedded data ────────────────────────────
  // Some modern team pages embed structured JSON-LD in a <script> tag.
  // If the above selectors yield nothing, look for:
  //   $('script[type="application/ld+json"]').each((_, el) => {
  //     try {
  //       const data = JSON.parse($(el).html());
  //       // Inspect `data` shape and extract players from it
  //     } catch {}
  //   });

  return entries;
}
