import fs from 'node:fs/promises';
import path from 'node:path';
import { probeRpc } from './probe.js';
import { getJson, sleep } from './http.js';
import { hostsFromCrtSh, pickPatterns } from './sources/ct-hostnames.js';
import { slug, nowIso, uniq } from './util.js';

/**
 * Watchlist: projecten die je al KENT, maar waarvan de mainnet nog moet komen.
 *
 * Het gat dat dit dicht: een project als GIWA of Ritual draait al maanden als
 * testnet en staat dus al in elke bron. Komt de mainnet, dan is het voor de
 * rest van de tool "een bekende naam in een nieuwe fase" — en de publieke
 * mainnet volgt vaak pas na een besloten fase waarin er niets te registreren
 * valt. Hier volgen we zulke projecten gericht, met drie signalen:
 *
 *   1. naam   — een detectie uit wélke bron dan ook die bij een watchlist-
 *               project hoort, gaat altijd door (ook als cross-listing) en
 *               krijgt voorrang.
 *   2. RPC    — kandidaat-URL's (gegokt, of de testnet-RPC zelf) worden elke
 *               run om hun chain ID gevraagd. Een chain ID dat we nog niet
 *               kennen = een nieuwe chain van dit team.
 *   3. domein — Certificate Transparency op het projectdomein. Een nieuw
 *               certificaat voor `rpc.` of `mainnet.` verschijnt vaak dagen
 *               vóór de aankondiging.
 *
 * De lijst zelf staat in data/watchlist.json en is van jou; de bot schrijft
 * alleen in data/watch-state.json.
 */

// Hostnamen die op productie-infra wijzen. Alles met test/sepolia/staging
// erin wordt stil vastgelegd: dat is geen mainnet-signaal.
const INTERESTING_HOST = /(^|[.-])(mainnet|rpc|explorer|scan|bridge|swap|dex|sequencer|node|api|ws|wss|app|portal)\d*([.-]|$)/;
const TEST_HOST = /(^|[.-])(test|testnet|sepolia|holesky|hoodi|goerli|devnet|dev|staging|stage|preview|qa|demo|faucet)([.-]|\d|$)/;

const RPC_TIMEOUT_MS = 6000;
const HOST_PROBE_LIMIT = 15;
const MAX_HOSTS_PER_DOMAIN = 600;

// ---- Opslag -------------------------------------------------------------------
// Twee bestanden met een bewuste scheiding: watchlist.json schrijf JIJ (welke
// projecten volgen we), watch-state.json schrijft de BOT (wat hij al gezien
// heeft). Zou de bot in jouw bestand schrijven, dan botst elke handmatige
// wijziging met de state-commit van de workflow.
const DATA = () => process.env.CHAINWATCH_DATA || 'data';
const WATCHLIST_FILE = () => path.join(DATA(), 'watchlist.json');
const WATCH_STATE_FILE = () => path.join(DATA(), 'watch-state.json');

/** Zelfde regel als store.js: "bestaat niet" is prima, "corrupt" faalt hard. */
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`kan ${file} niet lezen: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is corrupt (${e.message}). Herstel het bestand.`);
  }
}

export async function loadWatchlist() {
  const raw = await readJson(WATCHLIST_FILE(), { projects: [] });
  const list = Array.isArray(raw) ? raw : raw?.projects;
  if (!Array.isArray(list)) throw new Error(`${WATCHLIST_FILE()} bevat geen "projects"-array`);
  return list.filter((p) => p && typeof p.id === 'string' && p.enabled !== false);
}

export async function loadWatchState() {
  const obj = await readJson(WATCH_STATE_FILE(), {});
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${WATCH_STATE_FILE()} bevat geen object`);
  }
  return obj;
}

export async function saveWatchState(state) {
  // Gesorteerd, zodat een ongewijzigde state byte-identiek blijft en de
  // workflow niets te committen heeft.
  const out = {};
  for (const id of Object.keys(state).sort()) {
    const s = state[id] || {};
    out[id] = {
      hosts: Object.fromEntries(
        Object.entries(s.hosts || {}).sort(([a], [b]) => a.localeCompare(b))
          .map(([d, list]) => [d, [...new Set(list)].sort()])
      ),
      firedChainIds: [...new Set((s.firedChainIds || []).map(String))].sort(),
      bypassed: [...new Set(s.bypassed || [])].sort(),
    };
  }
  const file = WATCH_STATE_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 2));
  await fs.rename(tmp, file);
  return out;
}

// ---- crt.sh --------------------------------------------------------------------
// Eigen query met retries: crt.sh geeft onder last 404's, 502's en kapotte JSON
// terug die gewoon tijdelijk zijn (zie ook sources/ct-hostnames.js).
async function queryCrtSh(pattern, deadline) {
  const base = (process.env.CT_BASE_URL || 'https://crt.sh').replace(/\/$/, '');
  const url = `${base}/?q=${encodeURIComponent(pattern)}&output=json`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      return await getJson(url, { timeout: Math.min(25000, left), retries: 0 });
    } catch (e) {
      lastErr = e;
      const st = e.status;
      if (!(st === undefined || st === 404 || st === 429 || st >= 500)) break;
      const pause = Math.min(1500 * 2 ** attempt, deadline - Date.now() - 2000);
      if (pause > 0) await sleep(pause);
    }
  }
  throw lastErr || new Error('tijdsbudget op');
}

/**
 * Hoort deze naam bij een watchlist-project?
 *
 * Bewust streng: een alias moet een heel woord zijn, of — bij aliassen van
 * minstens vijf tekens — het begin van de naam. Anders matcht "arc" op
 * "Arcadia" en krijg je een watchlist-alert voor iets heel anders.
 */
export function matchProject(name, projects) {
  const raw = String(name || '');
  const words = new Set(
    raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().normalize('NFKD')
      .split(/[^a-z0-9]+/).filter(Boolean)
  );
  const whole = slug(raw);
  for (const p of projects) {
    for (const alias of uniq([p.id, ...(p.aliases || [])].map(slug))) {
      if (!alias) continue;
      if (words.has(alias)) return p;
      if (alias.length >= 5 && whole.startsWith(alias)) return p;
    }
  }
  return null;
}

function hostOf(u) {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase(); }
  catch { return null; }
}

/**
 * Hoort deze detectie bij een watchlist-project? Eerst op naam, dan op domein:
 * een chain-ID-aanvraag met een RPC op giwa.io is van GIWA, hoe de PR ook heet.
 */
export function matchRecord(c, projects) {
  const byName = matchProject(c?.name, projects);
  if (byName) return byName;
  const hosts = uniq([c?.host, c?.website, c?.liveRpc, ...(c?.rpc || []), ...(c?.explorers || [])]
    .filter((u) => typeof u === 'string').map(hostOf));
  for (const p of projects) {
    for (const d of (p.domains || []).map((x) => String(x).toLowerCase())) {
      if (hosts.some((h) => h === d || h.endsWith(`.${d}`))) return p;
    }
  }
  return null;
}

/** Welke fasen van een watchlist-project zijn het melden waard. */
export function isWatchWorthy(kind) {
  return kind !== 'testnet' && kind !== 'devnet';
}

/**
 * Een nieuw subdomein: telt het? Alleen het deel vóór het projectdomein wordt
 * bekeken, anders zou een domein als testchain.io alles als test-infra wegzetten.
 */
export function classifyHost(host, domain = '') {
  let h = String(host || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  if (d && h.endsWith(`.${d}`)) h = h.slice(0, -(d.length + 1));
  else if (d && h === d) return null;
  if (TEST_HOST.test(h)) return null;
  if (INTERESTING_HOST.test(h)) return 'interesting';
  return null;
}

function pinned(p) {
  return new Set((p.knownChainIds || []).map(String));
}

function eventBase(p) {
  return {
    source: 'watchlist',
    ecosystem: p.ecosystem || null,
    website: p.website || null,
    socials: p.socials || null,
    description: p.note || null,
    watch: { id: p.id, name: p.name || p.id },
    url: p.website || (p.domains?.[0] ? `https://${p.domains[0]}` : 'https://github.com'),
    detectedAt: nowIso(),
  };
}

function rpcEvent(p, hit, via) {
  return {
    ...eventBase(p),
    key: `watch:rpc:${p.id}:${hit.chainId}`,
    kind: 'watch',
    watchKind: 'rpc',
    name: `${p.name || p.id} — nieuwe chain ID ${hit.chainId}`,
    chainId: hit.chainId,
    block: hit.block,
    flavor: hit.flavor,
    liveRpc: hit.rpc,
    rpc: [hit.rpc],
    via,
    score: 97,
    reasons: ['watchlist', 'RPC antwoordt met onbekend chain ID'],
  };
}

function hostEvent(p, host, domain) {
  return {
    ...eventBase(p),
    key: `watch:host:${host}`,
    kind: 'watch',
    watchKind: 'host',
    name: `${p.name || p.id} — nieuw subdomein ${host}`,
    host,
    domain: null, // niet verwarren met de RDAP-verrijking die ook 'domain' heet
    watchDomain: domain,
    chainId: null,
    rpc: [],
    score: 72,
    reasons: ['watchlist', 'nieuw certificaat op het projectdomein'],
  };
}

/**
 * Eén run van de watchlist.
 *
 * Geeft `events` terug plus een `commit(failed)` die de state bijwerkt. Die
 * scheiding is dezelfde als elders in de tool: pas als een alert echt is
 * afgeleverd telt hij als gezien, anders komt hij de volgende run terug.
 *
 * `baselineOnly` (bootstrap) legt vast wat er nu is, zonder iets te melden.
 */
export async function runWatchlist(projects, state, {
  budgetMs = 30000,
  crtPerRun = 1,
  baselineOnly = false,
  now = Date.now(),
} = {}) {
  const events = [];
  const deadline = Date.now() + budgetMs;
  // Wijzigingen verzamelen we apart en passen ze pas in commit() toe.
  const pendingHosts = []; // { id, domain, host, key|null }
  const newDomainBaselines = []; // { id, domain, hosts[] }
  const firedIds = []; // { id, chainId, key }

  const firedFor = (p) => new Set((state[p.id]?.firedChainIds || []).map(String));

  // ---- 1. Kandidaat-RPC's ---------------------------------------------------
  // Klein en goedkoop: een handvol URL's per project, parallel per project.
  await Promise.all(projects.map(async (p) => {
    const known = pinned(p);
    const fired = firedFor(p);
    for (const url of uniq(p.rpc || [])) {
      if (Date.now() > deadline) return;
      const hit = await probeRpc(url, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => ({ live: false }));
      if (!hit.live || hit.chainId == null) continue;
      const id = String(hit.chainId);
      if (known.has(id) || fired.has(id)) continue;
      const ev = rpcEvent(p, hit, 'kandidaat-RPC');
      firedIds.push({ id: p.id, chainId: id, key: ev.key });
      fired.add(id);
      if (!baselineOnly) events.push(ev);
    }
  }));

  // ---- 2. Certificate Transparency op de projectdomeinen ---------------------
  // Eén domein per run, roulerend: crt.sh is wankel en we willen de bron voor
  // de gewone stealth-detectie niet uitputten.
  const pairs = projects.flatMap((p) => (p.domains || []).map((d) => ({ p, domain: String(d).toLowerCase() })));
  const chosen = pairs.length ? pickPatterns(pairs, Math.min(crtPerRun, pairs.length), now) : [];

  for (const { p, domain } of chosen) {
    if (Date.now() > deadline - 3000) break;
    let rows;
    try {
      rows = await queryCrtSh(`%.${domain}`, Math.min(deadline, Date.now() + 25000));
    } catch (e) {
      // Stil: de gewone ct-hostnames-bron meldt al als crt.sh structureel plat
      // ligt. Een gemiste beurt haalt de volgende in (crt.sh geeft de historie).
      console.warn(`[watchlist] crt.sh voor ${domain} mislukt: ${e.message}`);
      continue;
    }
    const onDomain = (h) => h === domain || h.endsWith(`.${domain}`);
    // Baseline over de HELE historie: anders geldt een bestaande RPC waarvan
    // het certificaat over twee maanden vernieuwd wordt ineens als nieuw.
    const allHosts = hostsFromCrtSh(rows, { maxAgeDays: 3650, now }).filter(onDomain);
    const hosts = hostsFromCrtSh(rows, { maxAgeDays: 45, now }).filter(onDomain);
    const seenHosts = state[p.id]?.hosts?.[domain];

    if (!Array.isArray(seenHosts)) {
      // Eerste keer dat we dit domein bekijken: alles wat er nu is, is oud nieuws.
      newDomainBaselines.push({ id: p.id, domain, hosts: allHosts });
      console.log(`[watchlist] ${domain}: baseline van ${allHosts.length} hostnamen`);
      continue;
    }

    const seen = new Set(seenHosts);
    const fresh = hosts.filter((h) => !seen.has(h));
    const known = pinned(p);
    const fired = firedFor(p);
    let probed = 0;

    for (const host of fresh) {
      // Elk vers subdomein even aankloppen: antwoordt het met een chain ID dat
      // we niet kennen, dan is dit het sterkste signaal dat er bestaat.
      let hit = { live: false };
      if (probed < HOST_PROBE_LIMIT && Date.now() < deadline) {
        probed++;
        hit = await probeRpc(`https://${host}`, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => ({ live: false }));
      }
      const id = hit.live && hit.chainId != null ? String(hit.chainId) : null;

      if (id && !known.has(id) && !fired.has(id)) {
        const ev = rpcEvent(p, hit, `nieuw subdomein ${host}`);
        ev.host = host;
        fired.add(id);
        firedIds.push({ id: p.id, chainId: id, key: ev.key });
        pendingHosts.push({ id: p.id, domain, host, key: ev.key });
        if (!baselineOnly) events.push(ev);
      } else if (!id && classifyHost(host, domain)) {
        const ev = hostEvent(p, host, domain);
        pendingHosts.push({ id: p.id, domain, host, key: ev.key });
        if (!baselineOnly) events.push(ev);
      } else {
        // Test-infra, een bekende chain, of niets bijzonders: stil vastleggen.
        pendingHosts.push({ id: p.id, domain, host, key: null });
      }
    }
    console.log(`[watchlist] ${domain}: ${hosts.length} hostnamen, ${fresh.length} nieuw, ${probed} gepolld`);
  }

  function commit(failed = new Set()) {
    for (const p of projects) {
      state[p.id] ||= {};
      state[p.id].hosts ||= {};
      state[p.id].firedChainIds ||= [];
      state[p.id].bypassed ||= [];
    }
    for (const b of newDomainBaselines) state[b.id].hosts[b.domain] = b.hosts;
    for (const h of pendingHosts) {
      if (h.key && failed.has(h.key)) continue; // volgende beurt opnieuw
      const list = (state[h.id].hosts[h.domain] ||= []);
      list.push(h.host);
      // Oudste eruit als het uit de hand loopt; de nieuwste zijn relevant.
      if (list.length > MAX_HOSTS_PER_DOMAIN) list.splice(0, list.length - MAX_HOSTS_PER_DOMAIN);
    }
    for (const f of firedIds) {
      if (failed.has(f.key)) continue;
      state[f.id].firedChainIds.push(f.chainId);
    }
    // Projecten die van de lijst zijn gehaald ruimen we op.
    const ids = new Set(projects.map((p) => p.id));
    for (const id of Object.keys(state)) if (!ids.has(id)) delete state[id];
    return state;
  }

  console.log(`[watchlist] ${projects.length} project(en), ${events.length} signaal/signalen`);
  return { events, commit };
}
