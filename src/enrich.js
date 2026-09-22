import { getJson, getText, gh } from './http.js';
import { uniq } from './util.js';

/**
 * Verrijking: probeert bij een gedetecteerde chain zelf de socials en een paar
 * "hoe vroeg zijn we"-signalen te vinden.
 *
 * Alles hier is BEST-EFFORT. Een chain zonder socials is nog steeds een alert
 * waard, dus geen enkele fout in dit bestand mag een detectie tegenhouden.
 * Daarom: geen retries, korte timeouts, alles in try/catch, en een harde
 * bovengrens op het aantal chains dat per run verrijkt wordt.
 */

const DAY = 86400000;

// TLD's met twee labels; zonder deze lijst wordt 'foo.co.uk' afgekapt tot 'co.uk'.
const MULTI_LABEL_TLD = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'com.br', 'com.ar', 'com.mx', 'co.in', 'com.tr', 'co.za',
  'com.sg', 'co.nz', 'com.hk', 'com.tw', 'co.il', 'com.cn', 'net.cn', 'org.cn',
  'com.ua', 'co.id', 'com.pl', 'com.es', 'com.vn', 'co.th', 'com.ph',
]);

/** Registreerbare domeinnaam uit een URL of hostname. Null als het niets oplevert. */
export function apexOf(input) {
  if (!input) return null;
  let host = String(input).trim();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null; // IP of onzin
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  const take = MULTI_LABEL_TLD.has(lastTwo) ? 3 : 2;
  if (parts.length < take) return null;
  return parts.slice(-take).join('.');
}

// Domeinen die nooit de website van een chain zelf zijn.
const INFRA_DOMAINS = new Set([
  'github.com', 'github.io', 'githubusercontent.com', 'gitbook.io', 'gitbook.com',
  'chainlist.org', 'chainid.network', 'blockscout.com', 'etherscan.io', 'routescan.io',
  'ankr.com', 'alchemy.com', 'infura.io', 'quicknode.com', 'drpc.org', 'publicnode.com',
  'llamarpc.com', 'onfinality.io', 'blastapi.io', 'nodereal.io', 'tenderly.co',
  'amazonaws.com', 'cloudfront.net', 'vercel.app', 'netlify.app', 'notion.site',
  'medium.com', 'substack.com', 'x.com', 'twitter.com', 't.me', 'discord.gg',
  'thirdweb.com', 'safe.global', 'omniatech.io', 'rpc.org', 'dwellir.com',
]);

/** Kandidaat-websites, beste eerst: expliciet veld > explorer > rpc. */
export function websiteCandidates(c) {
  const raw = [
    c.website,
    c.infoURL,
    ...(c.explorers || []),
    ...(c.rpc || []),
  ];
  const seen = new Set();
  const out = [];
  for (const u of raw) {
    const apex = apexOf(u);
    if (!apex || INFRA_DOMAINS.has(apex) || seen.has(apex)) continue;
    seen.add(apex);
    out.push(apex);
  }
  return out;
}

// --- Socials uit HTML ------------------------------------------------------

// Handles die op vrijwel elke site staan maar niets met het project te maken hebben.
const X_BLOCK = new Set([
  'intent', 'share', 'home', 'i', 'search', 'hashtag', 'explore', 'compose',
  'messages', 'login', 'signup', 'privacy', 'tos', 'about', 'settings', 'notifications',
]);
const GH_BLOCK = new Set([
  'features', 'about', 'pricing', 'login', 'join', 'topics', 'explore', 'marketplace',
  'apps', 'security', 'site', 'contact', 'enterprise', 'settings', 'sponsors',
  'collections', 'customer-stories', 'readme', 'trending', 'new', 'notifications',
  'codespaces', 'copilot', 'solutions', 'resources', 'events', 'premium-support',
]);
const TG_BLOCK = new Set(['share', 'joinchat', 'addstickers', 'proxy', 'socks', 'iv']);

const SOCIAL_PATTERNS = [
  ['x', /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{2,15})(?![A-Za-z0-9_])/gi, X_BLOCK, (h) => `https://x.com/${h}`],
  ['telegram', /https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_+]{3,64})/gi, TG_BLOCK, (h) => `https://t.me/${h}`],
  ['discord', /https?:\/\/(?:www\.)?discord(?:\.gg|(?:app)?\.com\/(?:invite|servers))\/([A-Za-z0-9-]{2,64})/gi, new Set(), (h) => `https://discord.gg/${h}`],
  ['github', /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/gi, GH_BLOCK, (h) => `https://github.com/${h}`],
];

const DOCS_RE = /https?:\/\/(?:docs|developer|developers|dev)\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>)]*)?|https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/docs(?:\/[^\s"'<>)]*)?/gi;

/**
 * Trekt socials uit ruwe HTML. Bewust regex op de hele bron i.p.v. alleen <a
 * href>: veel chain-sites zijn SPA's waar de links pas in een JS-bundel of in
 * JSON-LD staan, en die komen in de HTML wel als string voorbij.
 */
export function parseSocials(html, { apex } = {}) {
  const found = {};
  for (const [kind, re, block, build] of SOCIAL_PATTERNS) {
    const hits = [];
    for (const m of String(html).matchAll(re)) {
      const handle = m[1];
      if (!handle) continue;
      if (block.has(handle.toLowerCase())) continue;
      hits.push(build(handle));
    }
    // Meest voorkomende handle wint: navigatie-iconen staan vaak in header en
    // footer, willekeurige links in de body meestal een keer.
    const counts = new Map();
    for (const h of hits) counts.set(h, (counts.get(h) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) found[kind] = best[0];
  }

  const docs = uniq([...String(html).matchAll(DOCS_RE)].map((m) => m[0]))
    .filter((u) => !apex || u.includes(apex.split('.')[0]) || u.includes('/docs'))
    .filter((u) => !/gitbook\.io\/?$/.test(u));
  if (docs.length) found.docs = docs[0].replace(/[.,;]$/, '');

  const title = String(html).match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const desc =
    String(html).match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']{1,300})["']/i) ||
    String(html).match(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
  if (title) found.title = decodeEntities(title[1]).trim();
  if (desc) found.description = decodeEntities(desc[1]).trim();

  return found;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d{2,5});/g, (_, d) => String.fromCodePoint(Number(d)));
}

// --- Leeftijdssignalen -----------------------------------------------------

/**
 * Registratiedatum van het domein via RDAP (opvolger van WHOIS, gratis, geen key).
 * Dit is het sterkste "zijn we vroeg"-signaal dat er is: een chain met een
 * domein van twee weken oud is nog nergens gedeeld.
 */
export async function domainAge(apex) {
  const j = await getJson(`https://rdap.org/domain/${encodeURIComponent(apex)}`, {
    timeout: 9000,
    retries: 0,
    headers: { accept: 'application/rdap+json, application/json' },
  });
  const ev = (j?.events || []).find((e) => e.eventAction === 'registration');
  if (!ev?.eventDate) return null;
  const ts = Date.parse(ev.eventDate);
  if (!Number.isFinite(ts)) return null;
  return { apex, registeredAt: new Date(ts).toISOString(), ageDays: Math.floor((Date.now() - ts) / DAY) };
}

/** Leeftijd en omvang van de GitHub-org of -gebruiker achter een chain. */
export async function githubAge(login) {
  const u = await gh(`/users/${encodeURIComponent(login)}`, { timeout: 9000, retries: 0 });
  if (!u?.created_at) return null;
  const ts = Date.parse(u.created_at);
  return {
    login: u.login || login,
    type: u.type || null,
    repos: u.public_repos ?? null,
    createdAt: u.created_at,
    ageDays: Number.isFinite(ts) ? Math.floor((Date.now() - ts) / DAY) : null,
  };
}

// --- Orkestratie -----------------------------------------------------------

/** Probeert een homepage op te halen; eerst apex, dan www. */
async function fetchHome(apex) {
  for (const host of [apex, `www.${apex}`]) {
    try {
      return await getText(`https://${host}/`, { timeout: 10000 });
    } catch (e) {
      if (e.status && e.status !== 404 && e.status < 500) return null; // 401/403: geen tweede poging
    }
  }
  return null;
}

/**
 * Verrijkt een enkele chain. Muteert niet: geeft de extra velden terug.
 * Faalt nooit hard.
 */
export async function enrichOne(c, { deadline = Infinity } = {}) {
  const extra = {};
  const candidates = websiteCandidates(c).slice(0, 3);
  if (!candidates.length) return extra;

  for (const apex of candidates) {
    if (Date.now() > deadline) break;
    const page = await fetchHome(apex).catch(() => null);
    if (!page) continue;
    const socials = parseSocials(page.text, { apex });
    const hasAny = ['x', 'telegram', 'discord', 'github', 'docs'].some((k) => socials[k]);
    if (!hasAny && !socials.title) continue;

    extra.website = `https://${apex}`;
    extra.socials = socials;
    // Domeinleeftijd alleen van het domein dat we ook echt als site accepteren.
    if (Date.now() < deadline) {
      extra.domain = await domainAge(apex).catch(() => null);
    }
    if (socials.github && Date.now() < deadline) {
      const login = socials.github.split('/').pop();
      extra.github = await githubAge(login).catch(() => null);
    }
    break;
  }

  // Geen bruikbare site gevonden, maar wel een domein: de leeftijd is dan nog
  // steeds interessant (een verse RPC-domeinnaam zegt genoeg).
  if (!extra.website && candidates[0] && Date.now() < deadline) {
    extra.domain = await domainAge(candidates[0]).catch(() => null);
  }
  return extra;
}

/**
 * Verrijkt een lijst chains met een harde tijds- en aantalsbegrenzing.
 * De workflow heeft 10 minuten; verrijking mag daar nooit doorheen lopen.
 */
export async function enrichChains(chains, { limit = 12, budgetMs = 120000, concurrency = 3 } = {}) {
  if (process.env.ENRICH_SOCIALS === 'false' || process.env.CHAINWATCH_FIXTURE) return chains;
  const targets = chains.slice(0, limit);
  if (!targets.length) return chains;

  const deadline = Date.now() + budgetMs;
  let i = 0;
  let enriched = 0;

  async function worker() {
    while (i < targets.length) {
      const c = targets[i++];
      if (Date.now() > deadline) return;
      try {
        const extra = await enrichOne(c, { deadline });
        if (Object.keys(extra).length) {
          Object.assign(c, extra);
          enriched++;
        }
      } catch (e) {
        console.warn(`[enrich] ${c.name}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  const skipped = chains.length - targets.length;
  console.log(
    `[enrich] ${enriched}/${targets.length} verrijkt${skipped > 0 ? `, ${skipped} overgeslagen (limiet)` : ''}`
  );
  return chains;
}
