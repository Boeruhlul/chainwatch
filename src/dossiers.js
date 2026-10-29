import fs from 'node:fs/promises';
import path from 'node:path';
import { slug, classify, uniq, clamp } from './util.js';
import { apexOf, INFRA_DOMAINS } from './enrich.js';

/**
 * Dossiers: één permanent dossier per project, over alle bronnen heen.
 *
 * Elke bron levert losse detecties. Dit bestand is de laag die zegt: de
 * chain-ID-aanvraag van 12 september, het certificaat van 20 september en de
 * naamloze blob-afzender van vandaag zijn hetzelfde project. Daarvoor heeft
 * elk dossier een set identiteitssleutels:
 *
 *   n:<naam-slug>    de naam zonder 'testnet'/'mainnet'
 *   id:<chainId>     het chain ID (EVM) of de Cosmos chain-id
 *   d:<apex>         het registreerbare domein van de website
 *   gh:<org>         de GitHub-organisatie
 *   a:<adres>        sequencer-inbox of batcher-adres (stealth-vondsten)
 *
 * Deelt een nieuwe detectie een sleutel met een dossier, dan hoort hij erbij.
 * Deelt hij sleutels met TWEE dossiers, dan blijken dat hetzelfde project te
 * zijn: die worden samengevoegd. Dat is het "codenaam gekoppeld"-moment.
 *
 * Commit-ruis: dit bestand verandert alleen als er bewijs bijkomt. Alle
 * datums zijn dagen, geen tijdstippen, en er staan geen tellers in die per
 * run oplopen.
 */

const DATA = process.env.CHAINWATCH_DATA || 'data';
export const DOSSIER_FILE = path.join(DATA, 'dossiers.json');

const MAX_EVIDENCE = 30;
const MAX_ALIASES = 12;

/** Fasen, van vaag naar draaiend. De index is de volgorde. */
export const STAGES = ['lead', 'aangekondigd', 'devnet', 'testnet', 'draait', 'mainnet'];
const STAGE_LABEL = {
  lead: 'losse aanwijzing',
  aangekondigd: 'aangekondigd / aangevraagd',
  devnet: 'devnet',
  testnet: 'testnet',
  draait: 'draait (status onduidelijk)',
  mainnet: 'mainnet',
};
export const stageLabel = (s) => STAGE_LABEL[s] || s;

/**
 * Bronfamilies. Onafhankelijkheid telt per familie: een PR en de commit van
 * diezelfde PR zijn één signaal, niet twee.
 */
const FAMILY = {
  'ethlists-pr': 'register', 'ethlists-commit': 'register', 'keplr-pr': 'register',
  superchain: 'register', viem: 'code', l2beat: 'register', cosmos: 'register',
  chainlist: 'register', hyperlane: 'register', blockscout: 'register', glacier: 'register',
  lifi: 'markt', defillama: 'markt', coingecko: 'markt',
  'rollup-factory': 'onchain', 'blob-submitters': 'onchain', probe: 'onchain', inbox: 'onchain',
  'ct-hostnames': 'infra', watchlist: 'infra',
  'github-discovery': 'github', 'funding-rss': 'nieuws', research: 'onderzoek',
  ecosystem: 'onchain',
};
export const familyOf = (source) => FAMILY[source] || 'overig';

/** Registers waar een vermelding betekent dat het netwerk echt bestaat. */
const LIVE_REGISTRY = new Set([
  'ethlists-commit', 'chainlist', 'superchain', 'cosmos', 'hyperlane', 'blockscout',
  'glacier', 'lifi', 'defillama', 'coingecko', 'viem',
]);

/** Namen die als sleutel niets zeggen en alles aan elkaar zouden knopen. */
const GENERIC = new Set([
  'test', 'testnet', 'mainnet', 'devnet', 'chain', 'network', 'evm', 'rollup', 'layer',
  'ethereum', 'bitcoin', 'solana', 'base', 'polygon', 'arbitrum', 'optimism', 'avalanche',
  'cosmos', 'unknown', 'onbekend', 'blockchain', 'protocol', 'labs', 'safe', 'uniswapv2',
  'the', 'new', 'dev', 'app', 'dao', 'nft', 'defi', 'web', 'web3', 'zkevm', 'local', 'public', 'private',
]);

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : today());
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------------------------------------------------------------------------
// Opslag
// ---------------------------------------------------------------------------

export function emptyDb() {
  return { version: 1, dossiers: {}, outbox: [], digest: {} };
}

/** Zelfde discipline als store.js: ontbreekt = leeg, corrupt = hard falen. */
export async function loadDossiers(file = DOSSIER_FILE) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`kan ${file} niet lezen: ${e.message}`);
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is corrupt (${e.message}); herstel het of verwijder het (wordt dan opnieuw opgebouwd uit chains.json)`);
  }
  if (!db || typeof db.dossiers !== 'object') throw new Error(`${file} heeft geen dossiers-object`);
  db.outbox ||= [];
  db.digest ||= {};
  return db;
}

export async function saveDossiers(db, file = DOSSIER_FILE) {
  // Gesorteerd en zonder afgeleide index: identieke inhoud = identiek bestand.
  const dossiers = {};
  for (const id of Object.keys(db.dossiers).sort()) dossiers[id] = db.dossiers[id];
  const out = { version: 1, dossiers, outbox: db.outbox || [], digest: db.digest || {} };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 1));
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Sleutels
// ---------------------------------------------------------------------------

function nameSlugs(name) {
  const base = slug(name).replace(/(testnet|devnet|localnet|mainnet|sepolia)+$/, '');
  return base;
}

function addNameKey(keys, name) {
  if (!name || /^naamloze|^unnamed/i.test(String(name))) return;
  const s = nameSlugs(name);
  if (s.length >= 3 && !GENERIC.has(s) && !/^\d+$/.test(s)) keys.add(`n:${s}`);
}

/**
 * Hosting-platforms en stack-leveranciers. Een chain die op workers.dev draait
 * of naar matter-labs linkt is daarmee niet hetzelfde project als elke andere
 * chain die dat doet: zulke sleutels zouden alles aan elkaar knopen.
 */
const PLATFORM_DOMAINS = new Set([
  'workers.dev', 'pages.dev', 'cloudflare.com', 'herokuapp.com', 'onrender.com', 'railway.app',
  'fly.dev', 'web.app', 'firebaseapp.com', 'netlify.com', 'vercel.com', 'wixsite.com', 'carrd.co',
  'framer.app', 'framer.website', 'webflow.io', 'notion.so', 'linktr.ee', 'google.com', 'blogspot.com',
  'wordpress.com', 'replit.app', 'replit.dev', 'ngrok.io', 'ngrok-free.app', 'azurewebsites.net',
  'surge.sh', 'glitch.me', 'super.site', 'youtube.com', 'docs.google.com', 'telegram.org',
]);
const PLATFORM_ORGS = new Set([
  'cloudflare', 'vercel', 'netlify', 'taikoxyz', 'matter-labs', 'ethereum-optimism', 'offchainlabs',
  'cosmos', 'ignite', 'polygon', '0xpolygon', '0xpolygonhermez', 'conduit-xyz', 'calderaxyz',
  'gelatodigital', 'alt-research', 'altlayer', 'hyperlane-xyz', 'layerzero-labs', 'wevm', 'ethereum',
  'ethereum-lists', 'chainapsis', 'blockscout', 'foundry-rs', 'paradigmxyz', 'celestiaorg',
  'avalanche-foundation', 'ava-labs', 'scroll-tech', 'starkware-libs', 'arbitrumfoundation',
  'yourhandle', 'your-org', 'yourorg', 'username', 'user', 'example', 'github', 'features', 'orgs',
]);

/** Mag deze sleutel twee projecten aan elkaar knopen? */
export function allowedKey(k) {
  if (k.startsWith('d:')) {
    const apex = k.slice(2);
    // apexOf(apex) !== apex: oude sleutels als "d:org.mx" (een publiek
    // achtervoegsel, geen domein) mogen niets meer aan elkaar knopen.
    return !INFRA_DOMAINS.has(apex) && !PLATFORM_DOMAINS.has(apex) && apexOf(apex) === apex;
  }
  if (k.startsWith('gh:')) return !PLATFORM_ORGS.has(k.slice(3));
  return true;
}

function addDomainKey(keys, url) {
  if (!url) return;
  const s = String(url);
  const gh = s.match(/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/i);
  if (gh) {
    const k = `gh:${gh[1].toLowerCase()}`;
    if (allowedKey(k)) keys.add(k);
    return;
  }
  const apex = apexOf(s);
  if (apex && allowedKey(`d:${apex}`)) keys.add(`d:${apex}`);
}

/** Eigen domeinen van een detectie: website, RPC en explorer, zonder infra/platforms. */
export function domainsOf(r) {
  const out = new Set();
  for (const u of [r.website, r.infoURL, r.liveRpc, ...(r.rpc || []), ...(r.explorers || [])]) {
    if (!u || /github\.com/i.test(String(u))) continue;
    const apex = apexOf(u);
    if (apex && allowedKey(`d:${apex}`)) out.add(apex);
  }
  return out;
}

/** Alle identiteitssleutels die een detectie oplevert. */
export function keysOf(r) {
  const keys = new Set();
  // GitHub-leads heten naar hun repo ('genesis', 'node', ...): die naam zegt
  // niets over het project en zou losse teams aan elkaar knopen.
  if (r.kind !== 'stealth' && !r.noNameKey) addNameKey(keys, r.name);
  if (r.watch?.name) addNameKey(keys, r.watch.name);
  const rs = r.research;
  if (rs) {
    for (const a of rs.aliases || []) addNameKey(keys, a);
    for (const id of rs.chainIds || []) if (id != null && id !== '') keys.add(`id:${id}`);
  }
  // Chain ID's: het betrouwbaarste anker dat er is. Glacier-wegwerptestnets
  // komen hier niet eens langs (die filtert de caller).
  if (r.chainId != null && r.chainId !== '' && !r.chainIdMismatch) keys.add(`id:${String(r.chainId).replace(/^eip155:/, '')}`);
  addDomainKey(keys, r.website);
  addDomainKey(keys, r.infoURL);
  // Bewust NIET socials.github: die komt uit gescrapete HTML en wijst vaak naar
  // de stack (matter-labs, taikoxyz) in plaats van naar het project zelf.
  if (r.githubOrg && allowedKey(`gh:${String(r.githubOrg).toLowerCase()}`)) keys.add(`gh:${String(r.githubOrg).toLowerCase()}`);
  for (const a of [r.sequencerInbox, r.submitter, r.contract]) {
    if (typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a)) keys.add(`a:${a.toLowerCase()}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Fase en betrouwbaarheid
// ---------------------------------------------------------------------------

/** Welke fase bewijst dit stuk bewijs? */
export function stageOf(e) {
  switch (e.kind) {
    case 'mainnet': return 'mainnet';
    case 'testnet': return 'testnet';
    case 'devnet': return 'devnet';
    case 'proposal':
    case 'upcoming': return 'aangekondigd';
    case 'launched':
    case 'stealth':
      return e.testnetName ? 'testnet' : 'draait';
    case 'watch': return e.watchKind === 'rpc' ? (e.testnetName ? 'testnet' : 'draait') : 'lead';
    case 'eco': return 'draait';
    case 'research': return e.stage || 'lead';
    default: return 'lead';
  }
}

const RESEARCH_STAGE = {
  rumor: 'lead', development: 'aangekondigd', devnet: 'devnet', testnet: 'testnet',
  'private-mainnet': 'draait', mainnet: 'mainnet',
};

/** Sterkte van één stuk bewijs: running > technical > soft. */
function strengthOf(e) {
  if (e.kind === 'eco' || e.kind === 'launched') return 'running';
  if (e.kind === 'watch' && e.watchKind === 'rpc') return 'running';
  if (e.kind === 'stealth' && e.stealthKind === 'hostname') return 'running';
  if (['mainnet', 'testnet', 'devnet'].includes(e.kind) && LIVE_REGISTRY.has(e.source)) return 'running';
  if (e.kind === 'stealth' && e.stealthKind === 'blob') return 'onchain';
  if (e.source === 'funding-rss' || e.source === 'research') return 'soft';
  return 'technical';
}

const CONF_ORDER = ['D', 'C', 'B', 'A'];
const betterConf = (a, b) => (CONF_ORDER.indexOf(a) >= CONF_ORDER.indexOf(b) ? a : b);

/**
 * A–D met redenen. Geen percentages: we zeggen waarop het oordeel rust.
 *
 * A  er draait aantoonbaar iets, of een register heeft het netwerk opgenomen
 * B  meerdere onafhankelijke bronfamilies, of on-chain bewijs zonder naam
 * C  één technisch signaal
 * D  alleen nieuws of een losse onderzoekshypothese
 */
export function assess(d) {
  const ev = d.evidence || [];
  const fams = uniq(ev.map((e) => e.family));
  const strengths = new Set(ev.map((e) => e.strength));
  const techFams = uniq(ev.filter((e) => e.strength !== 'soft').map((e) => e.family));
  const reasons = [];
  let conf = 'D';

  if (strengths.has('running')) {
    conf = 'A';
    const e = ev.find((x) => x.strength === 'running');
    reasons.push(`draaiend netwerk aangetoond (${e.what})`);
  } else if (strengths.has('onchain')) {
    conf = 'B';
    reasons.push('on-chain activiteit zonder bekende naam');
  } else if (techFams.length >= 2 || (techFams.length >= 1 && fams.length >= 2)) {
    conf = 'B';
    reasons.push(`${fams.length} onafhankelijke bronfamilies: ${fams.join(', ')}`);
  } else if (techFams.length === 1) {
    conf = 'C';
    reasons.push(`één technisch signaal (${techFams[0]})`);
  } else {
    reasons.push(fams.length ? `alleen ${fams.join(', ')}` : 'geen bewijs');
  }

  // Een onderzoeksoordeel mag het niveau verhogen, nooit verlagen; het staat
  // apart vermeld zodat je ziet dat het niet uit de bot zelf komt.
  if (d.research?.confidence && CONF_ORDER.includes(d.research.confidence)) {
    const before = conf;
    conf = betterConf(d.research.confidence, conf);
    if (conf !== before) reasons.push(`onderzoeksoordeel ${d.research.confidence}`);
  }
  // Mogelijke imitatie of chain-ID-botsing: nooit hoger dan C, wat er ook draait.
  if (d.suspect) {
    if (CONF_ORDER.indexOf(conf) > CONF_ORDER.indexOf('C')) conf = 'C';
    reasons.unshift(d.suspect.type === 'imitatie'
      ? `⚠️ mogelijke imitatie van ${d.suspect.other}: domein wijkt af van het officiële`
      : `⚠️ chain ID botst met ${d.suspect.other}`);
  }
  if (d.eco?.dex?.length) reasons.push('DEX op de chain gevonden');
  if (d.eco?.launchpad?.length) reasons.push('launchpad-kandidaat op de chain');
  return { confidence: conf, reasons, families: fams };
}

// ---------------------------------------------------------------------------
// Bewijs uit een detectie
// ---------------------------------------------------------------------------

function whatOf(r) {
  const k = {
    mainnet: 'mainnet', testnet: 'testnet', devnet: 'devnet', proposal: 'chain-ID-aanvraag',
    upcoming: 'nieuw in tracking', launched: 'RPC antwoordt', stealth: 'onaangekondigd',
    watch: 'watchlist-signaal', lead: 'aanwijzing', research: 'onderzoek',
  }[r.kind] || r.kind;
  const bits = [k];
  if (r.chainId != null) bits.push(`ID ${r.chainId}`);
  if (r.stealthKind) bits.push(r.stealthKind);
  if (r.leadKind) bits.push(r.leadKind);
  return `${r.source}: ${bits.join(' · ')}`;
}

export function evidenceOf(r) {
  const testnetName = /test|sepolia|devnet/i.test(String(r.name || '')) || classify(r.name || '') !== 'mainnet';
  const e = {
    date: dayOf(r.detectedAt),
    source: r.source,
    family: familyOf(r.source),
    kind: r.kind,
    what: clamp(whatOf(r), 140),
    url: r.url || null,
  };
  if (r.stealthKind) e.stealthKind = r.stealthKind;
  if (r.watchKind) e.watchKind = r.watchKind;
  if ((r.kind === 'launched' || r.kind === 'stealth' || r.kind === 'watch') && testnetName) e.testnetName = true;
  if (r.kind === 'research') e.stage = RESEARCH_STAGE[r.research?.stage] || 'lead';
  e.strength = strengthOf(e);
  return e;
}

// ---------------------------------------------------------------------------
// Inname
// ---------------------------------------------------------------------------

function buildIndex(db) {
  const idx = new Map();
  for (const d of Object.values(db.dossiers)) {
    // Sleutels die achteraf platform bleken te zijn worden opgeruimd.
    if ((d.keys || []).some((k) => !allowedKey(k))) d.keys = d.keys.filter(allowedKey);
    for (const k of d.keys || []) idx.set(k, d.id);
  }
  return idx;
}

function newId(db, name) {
  const base = slug(name).slice(0, 40) || 'project';
  let id = base;
  for (let i = 2; db.dossiers[id]; i++) id = `${base}-${i}`;
  return id;
}

function cleanName(name) {
  // "Ritual — nieuwe chain ID 784" is een melding, geen naam.
  const base = String(name || '').split(' — ')[0];
  return clamp(base.replace(/\s+(testnet|mainnet|devnet)$/i, '').trim() || base, 80);
}

/** Namen die de bot zelf verzint voor iets naamloos zijn geen alias. */
const isPlaceholder = (n) => /^(naamloze|nieuwe rollup|onbekend|unnamed|unknown)/i.test(String(n || ''));

export function addEvidence(d, e) {
  d.evidence ||= [];
  const sig = `${e.source}|${e.kind}|${e.url}|${e.what}`;
  if (d.evidence.some((x) => `${x.source}|${x.kind}|${x.url}|${x.what}` === sig)) return false;
  d.evidence.push(e);
  d.evidence.sort((a, b) => a.date.localeCompare(b.date) || a.what.localeCompare(b.what));
  if (d.evidence.length > MAX_EVIDENCE) {
    // Het eerste bewijs blijft altijd staan: dat is "sinds wanneer weten we het".
    d.evidence = [d.evidence[0], ...d.evidence.slice(-(MAX_EVIDENCE - 1))];
  }
  if (e.date > (d.lastActivity || '')) d.lastActivity = e.date;
  return true;
}

function mergeFacts(d, r) {
  const nm = r.watch?.name || r.name;
  if (nm && !isPlaceholder(nm) && r.kind !== 'stealth') {
    d.aliases = uniq([...(d.aliases || []), cleanName(nm), ...(r.research?.aliases || [])]).slice(0, MAX_ALIASES);
  }
  if (r.chainId != null && !r.chainIdMismatch) d.chainIds = uniq([...(d.chainIds || []), String(r.chainId)]).slice(0, 8);
  for (const id of r.research?.chainIds || []) d.chainIds = uniq([...(d.chainIds || []), String(id)]).slice(0, 8);
  if (!d.website && (r.website || r.research?.website)) d.website = r.website || r.research.website;
  if (!d.architecture && (r.research?.architecture || (r.ecosystem && r.ecosystem !== 'onbekend'))) {
    d.architecture = r.research?.architecture || r.ecosystem;
  }
  if (!d.github && r.socials?.github) d.github = r.socials.github;
  const rpcs = [r.liveRpc, ...(r.rpc || []), ...(r.research?.rpc || [])].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  if (rpcs.length) d.rpc = uniq([...(d.rpc || []), ...rpcs]).slice(0, 4);
  if (r.liveRpc) d.liveRpc = r.liveRpc;
  const explorer = r.explorers?.[0] || r.research?.explorer;
  if (!d.explorer && typeof explorer === 'string' && /^https?:\/\//.test(explorer)) d.explorer = explorer;
  if (r.research) {
    const rs = r.research;
    d.research = {
      confidence: rs.confidence || null,
      org: rs.org || d.research?.org || null,
      why: rs.why || null,
      facts: (rs.facts || []).slice(0, 8),
      hypotheses: (rs.hypotheses || []).slice(0, 6),
      nextSignals: (rs.nextSignals || []).slice(0, 6),
      expectedLaunch: rs.expectedLaunch || null,
      ecosystem: rs.ecosystem || null,
      file: rs.file || null,
    };
    if (rs.org && !d.org) d.org = rs.org;
  }
}

function refresh(d, day) {
  const best = Math.max(...(d.evidence || []).map((e) => STAGES.indexOf(stageOf(e))), 0);
  const stage = STAGES[best];
  const prevStage = d.stage;
  if (stage !== prevStage) {
    d.stage = stage;
    d.stageHistory = [...(d.stageHistory || []), { stage, date: day }];
    if (stage === 'mainnet' && !d.mainnetSince) d.mainnetSince = day;
  }
  const a = assess(d);
  const prevConf = d.confidence;
  d.confidence = a.confidence;
  d.reasons = a.reasons;
  d.families = a.families;
  return { prevStage, prevConf };
}

function mergeInto(target, other) {
  target.aliases = uniq([...(target.aliases || []), other.name, ...(other.aliases || [])]).slice(0, MAX_ALIASES);
  target.keys = uniq([...(target.keys || []), ...(other.keys || [])]).sort();
  for (const e of other.evidence || []) addEvidence(target, e);
  for (const f of ['website', 'github', 'explorer', 'liveRpc', 'architecture', 'org', 'research', 'mainnetSince']) {
    if (!target[f] && other[f]) target[f] = other[f];
  }
  target.chainIds = uniq([...(target.chainIds || []), ...(other.chainIds || [])]);
  target.rpc = uniq([...(target.rpc || []), ...(other.rpc || [])]).slice(0, 4);
  target.eco = {
    dex: [...(target.eco?.dex || []), ...(other.eco?.dex || [])],
    launchpad: [...(target.eco?.launchpad || []), ...(other.eco?.launchpad || [])],
  };
  if (!target.eco.dex.length && !target.eco.launchpad.length) delete target.eco;
  target.alerted = { ...(other.alerted || {}), ...(target.alerted || {}) };
  if ((other.firstSeen || '9') < (target.firstSeen || '9')) target.firstSeen = other.firstSeen;
  target.stageHistory = [...(other.stageHistory || []), ...(target.stageHistory || [])]
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Verwerkt een reeks detecties in de dossiers.
 *
 * Geeft gebeurtenissen terug die een eigen melding verdienen. Detecties die
 * zelf al als alert de deur uitgaan (alertKeys) krijgen GEEN tweede melding:
 * ze krijgen de dossiercontext mee in hun eigen bericht (zie contextFor).
 *
 * Met quiet=true (opbouw uit de historie) komen er geen gebeurtenissen uit.
 */
export function ingest(db, records, { alertKeys = new Set(), quiet = false } = {}) {
  const idx = buildIndex(db);
  const events = [];
  const touched = new Map(); // id -> { prevStage, prevConf, created, trigger }

  for (const r of records) {
    const keys = keysOf(r);
    if (!keys.size) continue;
    const nm = r.watch?.name || r.name;
    const day = dayOf(r.detectedAt);
    let hits = uniq([...keys].map((k) => idx.get(k)).filter(Boolean))
      .map((id) => db.dossiers[id]).filter(Boolean);

    // Echtheidspoort: komt de naam of het chain ID overeen met een bekend
    // project, maar het domein niet, dan is het geen bewijs voor dat project
    // maar een mogelijke imitatie (nep-GIWA, chain ID 9134) of een botsing.
    // Zo'n detectie mag het echte dossier niet vervuilen en krijgt een eigen,
    // gemarkeerd dossier.
    const ownApex = domainsOf(r);
    if (hits.length && ownApex.size) {
      const kept = [];
      for (const h of hits) {
        const official = (h.keys || []).filter((k) => k.startsWith('d:')).map((k) => k.slice(2));
        const shared = [...keys].filter((k) => (h.keys || []).includes(k));
        const strong = shared.some((k) => /^(d|gh|a):/.test(k));
        if (strong || !official.length || official.some((a) => ownApex.has(a))) { kept.push(h); continue; }
        const viaName = shared.some((k) => k.startsWith('n:'));
        r.suspect = {
          type: viaName ? 'imitatie' : 'id-botsing',
          other: h.name, official: official.slice(0, 3), own: [...ownApex].slice(0, 3),
        };
        for (const k of shared) keys.delete(k);
      }
      hits = kept;
      if (r.suspect) for (const a of ownApex) keys.add(`d:${a}`);
    }

    let d;
    if (!hits.length) {
      const id = newId(db, cleanName(nm) || [...keys][0]);
      d = db.dossiers[id] = {
        id, name: cleanName(nm) || id, aliases: [], keys: [], firstSeen: day,
        lastActivity: day, stage: null, stageHistory: [], evidence: [],
      };
      if (r.suspect) d.suspect = r.suspect;
      touched.set(id, { prevStage: null, prevConf: null, created: true, trigger: r });
    } else {
      // Oudste dossier wint; de rest gaat erin op.
      hits.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || '') || a.id.localeCompare(b.id));
      d = hits[0];
      if (!touched.has(d.id)) touched.set(d.id, { prevStage: d.stage, prevConf: d.confidence, created: false, trigger: r });
      for (const other of hits.slice(1)) {
        const wasNew = touched.get(other.id)?.created;
        mergeInto(d, other);
        for (const k of other.keys || []) idx.set(k, d.id);
        delete db.dossiers[other.id];
        touched.delete(other.id);
        // Koppeling van twee al bekende dossiers met een andere naam: dat is
        // het moment waarop een codenaam aan een project vastklikt.
        if (!quiet && !wasNew && slug(other.name) !== slug(d.name)) {
          events.push({
            type: 'link', id: d.id, key: `dossier:link:${d.id}:${other.id}`,
            linked: other.name, via: [...keys].filter((k) => (other.keys || []).includes(k)),
            trigger: { source: r.source, url: r.url, name: r.name },
          });
        }
      }
    }

    if (isPlaceholder(d.name) && nm && !isPlaceholder(nm) && r.kind !== 'stealth') d.name = cleanName(nm);
    d.keys = uniq([...(d.keys || []), ...keys]).sort();
    for (const k of keys) idx.set(k, d.id);
    addEvidence(d, evidenceOf(r));
    mergeFacts(d, r);
    if (r.key) r.dossierId = d.id;
  }

  for (const [id, t] of touched) {
    const d = db.dossiers[id];
    if (!d) continue;
    const { prevConf } = refresh(d, d.lastActivity || today());
    if (quiet) continue;
    const triggerAlerted = t.trigger?.key && alertKeys.has(t.trigger.key);
    if (t.created) continue; // een nieuw dossier meldt zich via zijn eigen detectie of het dagoverzicht
    // Opwaardering door correlatie: het nieuwe bewijs zelf gaat niet als alert
    // de deur uit, maar samen met wat we al hadden is het nu sterk.
    const up = prevConf && CONF_ORDER.indexOf(d.confidence) > CONF_ORDER.indexOf(prevConf);
    if (up && ['A', 'B'].includes(d.confidence) && !triggerAlerted) {
      events.push({
        type: 'upgrade', id, key: `dossier:up:${id}:${d.confidence}`, from: prevConf, to: d.confidence,
        trigger: { source: t.trigger?.source, url: t.trigger?.url, name: t.trigger?.name },
      });
    }
  }
  return events;
}

/** Context voor een gewone alert: wat wisten we al over dit project? */
export function contextFor(db, r) {
  const d = r?.dossierId && db.dossiers[r.dossierId];
  if (!d) return null;
  const earlier = (d.evidence || []).filter((e) => e.url !== r.url).slice(0, 4);
  return {
    id: d.id, confidence: d.confidence, reasons: d.reasons, firstSeen: d.firstSeen,
    stage: d.stage, aliases: (d.aliases || []).filter((a) => slug(a) !== slug(cleanName(r.name))).slice(0, 4),
    earlier: earlier.map((e) => ({ date: e.date, what: e.what })),
    families: d.families,
  };
}

/**
 * Hoort dit dossier op dit moment intensief gevolgd te worden?
 *
 * Tot aan mainnet zolang er de afgelopen 180 dagen iets gebeurde, en daarna
 * nog 14 dagen. Daarna terug naar gewone monitoring.
 */
export function isIntensive(d, day = today()) {
  if (!d) return false;
  const si = STAGES.indexOf(d.stage);
  if (si < STAGES.indexOf('devnet') && !d.liveRpc) return false;
  if (d.stage === 'mainnet') return d.mainnetSince ? daysBetween(d.mainnetSince, day) <= 14 : false;
  return d.lastActivity ? daysBetween(d.lastActivity, day) <= 180 : false;
}

/**
 * Eerste opbouw uit de bestaande historie (chains.json). Stil: wat al gemeld
 * is wordt niet opnieuw gemeld. Glacier-wegwerptestnets blijven erbuiten.
 */
export function bootstrapFrom(history, { skip = () => false } = {}) {
  const db = emptyDb();
  const sorted = [...history]
    .filter((c) => !skip(c))
    .sort((a, b) => String(a.detectedAt).localeCompare(String(b.detectedAt)));
  ingest(db, sorted, { quiet: true });
  return db;
}

/** Fase en oordeel opnieuw bepalen na een wijziging buiten ingest om. */
export function reassess(d) {
  return refresh(d, d.lastActivity || today());
}

export const _test = { keysOf, evidenceOf, assess, CONF_ORDER };
