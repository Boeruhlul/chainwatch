import { PATTERNS, parsePoolLog } from './pools.js';
import { topicToAddress } from './evm.js';
import { isIntensive, addEvidence, reassess } from './dossiers.js';
import { uniq } from './util.js';

/**
 * Ecosysteem-scan: draait er op een nieuwe chain al een DEX of een launchpad?
 *
 * Dit is het noxa.fun-geval. De chain zelf is pas de helft; wat je wilt weten
 * is waar je er als eerste iets op kunt doen. Voor elk dossier dat intensief
 * gevolgd wordt (pre-launch, of de eerste 14 dagen na mainnet) en een RPC
 * heeft, lezen we de logboeken van de laatste blokken:
 *
 *   DEX        elke Uniswap-, Solidly-, Algebra- of v4-fork stuurt dezelfde
 *              PairCreated/PoolCreated/Initialize. Het contract dat die
 *              uitzendt is de fabriek, dus de DEX. Patronen komen uit
 *              dex-pools.js en zijn daar door een test nagerekend.
 *
 *   launchpad  een bonding-curve-platform (pump.fun en klonen) munt de hele
 *              voorraad van elk nieuw token naar zijn eigen contract. Eén
 *              contract dat de beginvoorraad van drie of meer verse tokens
 *              ontvangt is dus vrijwel altijd een launchpad of token-fabriek.
 *              Daarom: Transfer(from = 0x0), gegroepeerd op ontvanger.
 *
 * Stateloos: welk dossier deze run aan de beurt is volgt uit de klok, en er
 * wordt geen blokstand bewaard. Een fabriek of launchpad blijft gebeurtenissen
 * uitzenden, dus wat deze ronde buiten het venster valt komt de volgende keer
 * terug. Zo levert de scan geen commit-ruis op.
 */

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const IGNORE_RECIPIENT = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);
const POOL_TOPICS = PATTERNS.map((p) => p.topic);
const SPANS = [20000, 5000, 1000];
const MIN_LAUNCHPAD_TOKENS = 3;
const TIMEOUT_MS = 10000;

async function rpc(url, method, params = []) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(body.error.message || 'rpc error');
    return body?.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Logs over het grootste venster dat de node accepteert. */
async function logsBackward(url, latest, topics) {
  let lastErr;
  for (const span of SPANS) {
    const from = Math.max(0, latest - span);
    try {
      const logs = await rpc(url, 'eth_getLogs', [{
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${latest.toString(16)}`, topics,
      }]);
      if (Array.isArray(logs)) return { logs, span: latest - from };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('geen logs');
}

/** Namen die op een dapp wijzen die de moeite van het noemen waard is. */
export const DAPP_NAME = /(launch|pad|pump|bond|curve|fun|factory|router|swap|dex|amm|perp|vault|lend|borrow|stak|bridge|points|airdrop|claim|presale|sale|farm|yield|market|oracle|pool)/i;

/** Blockscout v2: nieuwste geverifieerde contracten. Best-effort, één pagina. */
export async function namedContracts(explorer) {
  const base = String(explorer).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/api/v2/smart-contracts?q=&filter=solidity`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.items || [])
      .map((it) => ({ name: it?.address?.name, addr: String(it?.address?.hash || '').toLowerCase() }))
      .filter((c) => c.name && /^0x[0-9a-f]{40}$/.test(c.addr) && DAPP_NAME.test(c.name))
      .slice(0, 20);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Pure analyse, los getest: welke fabrieken en launchpad-kandidaten zitten erin? */
export function analyze(poolLogs, mintLogs) {
  const factories = new Map(); // emitter -> { type, pools:Set }
  const pools = new Set();
  for (const log of poolLogs || []) {
    const p = parsePoolLog(log);
    if (!p?.emitter) continue;
    if (!factories.has(p.emitter)) factories.set(p.emitter, { type: p.dex, pools: new Set() });
    if (p.pool) {
      factories.get(p.emitter).pools.add(p.pool);
      pools.add(p.pool);
    }
  }

  const byRecipient = new Map(); // ontvanger -> Set(token)
  const tokens = new Set();
  for (const log of mintLogs || []) {
    if (String(log?.topics?.[0]).toLowerCase() !== TRANSFER) continue;
    if (log.topics.length !== 3) continue; // ERC-721 heeft 4 topics: geen tokenlancering
    const token = String(log.address || '').toLowerCase();
    if (!token || pools.has(token)) continue; // LP-tokens van pools tellen niet
    const to = topicToAddress(log.topics[2]);
    if (!to || IGNORE_RECIPIENT.has(to) || to === token) continue;
    tokens.add(token);
    if (!byRecipient.has(to)) byRecipient.set(to, new Set());
    byRecipient.get(to).add(token);
  }

  const dex = [...factories.entries()]
    .map(([addr, f]) => ({ addr, type: f.type, pools: f.pools.size }))
    .sort((a, b) => b.pools - a.pools);
  const launchpad = [...byRecipient.entries()]
    .filter(([, set]) => set.size >= MIN_LAUNCHPAD_TOKENS)
    .map(([addr, set]) => ({ addr, tokens: set.size }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
  return { dex, launchpad, newTokens: tokens.size, pools: pools.size };
}

async function scanOne(d) {
  const urls = uniq([d.liveRpc, ...(d.rpc || [])]).filter((u) => /^https?:\/\//.test(u || ''));
  let url = null;
  let chainId = null;
  for (const u of urls.slice(0, 3)) {
    try {
      const hex = await rpc(u, 'eth_chainId');
      if (typeof hex === 'string' && /^0x[0-9a-f]+$/i.test(hex)) {
        url = u;
        chainId = Number.parseInt(hex, 16);
        break;
      }
    } catch { /* volgende */ }
  }
  if (!url) return null;
  const latest = Number.parseInt(await rpc(url, 'eth_blockNumber'), 16);
  if (!Number.isFinite(latest)) return null;

  const [pool, mint] = await Promise.allSettled([
    logsBackward(url, latest, [POOL_TOPICS]),
    logsBackward(url, latest, [TRANSFER, ZERO_TOPIC]),
  ]);
  const a = analyze(
    pool.status === 'fulfilled' ? pool.value.logs : [],
    mint.status === 'fulfilled' ? mint.value.logs : []
  );

  // Een EOA die tokens ontvangt is een gebruiker, geen launchpad.
  const confirmed = [];
  for (const l of a.launchpad.slice(0, 3)) {
    try {
      const code = await rpc(url, 'eth_getCode', [l.addr, 'latest']);
      if (typeof code === 'string' && code.length > 2) confirmed.push(l);
    } catch { /* overslaan */ }
  }
  a.launchpad = confirmed;
  // Geverifieerde contracten met naam, als de explorer Blockscout is: zo zie
  // je de eerste dapps op een chain ("LaunchpadFactory", "PerpsVault") nog
  // voordat iemand ze aankondigt.
  const contracts = d.explorer ? await namedContracts(d.explorer) : [];
  return { ...a, rpc: url, chainId, latest, span: pool.value?.span ?? mint.value?.span ?? null, contracts };
}

/**
 * Kiest de dossiers voor deze run en scant ze binnen het budget.
 * Geeft per dossier de NIEUWE vondsten terug (nog niet in d.eco).
 */
export async function scanEcosystems(db, { limit = 12, budgetMs = 40000, now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const candidates = Object.values(db.dossiers)
    .filter((d) => !d.blocked && isIntensive(d, day) && (d.liveRpc || d.rpc?.length))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!candidates.length) return { findings: [], scanned: 0, candidates: 0 };

  // Roulatie op de klok: elke run een ander stuk van de lijst.
  const slot = Math.floor(now / 300000);
  const start = (slot * limit) % candidates.length;
  const pick = [];
  for (let i = 0; i < Math.min(limit, candidates.length); i++) pick.push(candidates[(start + i) % candidates.length]);

  const deadline = now + budgetMs;
  const findings = [];
  let scanned = 0;
  await Promise.all([0, 1, 2].map(async (w) => {
    for (let i = w; i < pick.length; i += 3) {
      if (Date.now() > deadline) return;
      const d = pick[i];
      try {
        const res = await scanOne(d);
        scanned++;
        if (!res) continue;
        const known = new Set([...(d.eco?.dex || []), ...(d.eco?.launchpad || [])].map((x) => x.addr));
        const dex = res.dex.filter((x) => !known.has(x.addr));
        const launchpad = res.launchpad.filter((x) => !known.has(x.addr));
        findings.push({ id: d.id, ...res, dex, launchpad, liveRpc: res.rpc });
      } catch (e) {
        console.warn(`[ecosystem] ${d.id}: ${e.message}`);
      }
    }
  }));
  return { findings, scanned, candidates: candidates.length };
}

/**
 * Verwerkt vondsten in de dossiers en levert gebeurtenissen op.
 * Alleen de EERSTE DEX en de EERSTE launchpad van een chain worden een directe
 * melding; latere komen als bewijs in het dossier en in het dagoverzicht.
 */
export function applyFindings(db, findings, { day = new Date().toISOString().slice(0, 10) } = {}) {
  const events = [];
  for (const f of findings) {
    const d = db.dossiers[f.id];
    if (!d) continue;
    if (f.liveRpc && !d.liveRpc) d.liveRpc = f.liveRpc;
    if (!f.dex.length && !f.launchpad.length) continue;
    d.eco ||= {};
    const firstDex = !(d.eco.dex || []).length && f.dex.length;
    const firstPad = !(d.eco.launchpad || []).length && f.launchpad.length;
    d.eco.dex = [...(d.eco.dex || []), ...f.dex.map((x) => ({ addr: x.addr, type: x.type, date: day }))].slice(0, 10);
    d.eco.launchpad = [...(d.eco.launchpad || []), ...f.launchpad.map((x) => ({ addr: x.addr, date: day }))].slice(0, 10);
    for (const x of f.dex) {
      addEvidence(d, { date: day, source: 'ecosystem', family: 'onchain', kind: 'eco', what: `ecosystem: DEX (${x.type}) ${x.addr.slice(0, 10)}…`, url: explorerLink(d, x.addr), strength: 'running' });
    }
    for (const x of f.launchpad) {
      addEvidence(d, { date: day, source: 'ecosystem', family: 'onchain', kind: 'eco', what: `ecosystem: launchpad-kandidaat ${x.addr.slice(0, 10)}…`, url: explorerLink(d, x.addr), strength: 'running' });
    }
    d.lastActivity = day;
    reassess(d);
    if (firstDex || firstPad) {
      events.push({
        type: 'eco', id: d.id, key: `dossier:eco:${d.id}:${firstDex ? 'dex' : ''}${firstPad ? 'pad' : ''}`,
        dex: f.dex, launchpad: f.launchpad, newTokens: f.newTokens, pools: f.pools,
        span: f.span, latest: f.latest, chainId: f.chainId, rpc: f.rpc,
      });
    }
  }
  return events;
}

export function explorerLink(d, addr) {
  return d.explorer ? `${d.explorer.replace(/\/+$/, '')}/address/${addr}` : null;
}

export const _test = { TRANSFER, ZERO_TOPIC, MIN_LAUNCHPAD_TOKENS };
