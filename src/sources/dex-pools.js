import { evmCall, hexToNum, numToHex, topicToAddress, addressWords } from '../evm.js';
import { loadPoolBlocks, savePoolBlocks } from '../store.js';
import { checkpoint } from './rollup-factory.js';

/**
 * Nieuwe liquiditeitspools op een handvol gekozen chains.
 *
 * Dit is een ander soort signaal dan de rest van de tool: niet "er is een
 * nieuwe chain", maar "op deze chain kun je vanaf nu iets nieuws verhandelen".
 *
 * We filteren op de handtekening van de gebeurtenis en NIET op het adres van
 * de fabriek. Dat is het omgekeerde van rollup-factory, en met reden: daar is
 * het fabrieksadres bekend en de handtekening per versie anders. Hier is het
 * precies andersom. Elke Uniswap-fork stuurt hetzelfde PairCreated/PoolCreated,
 * dus zo vangen we ook een DEX die gisteren is uitgerold en waarvan niemand het
 * adres kent. Uniswap v4 heeft geen fabriek maar één PoolManager met een
 * Initialize-event; die zit er om dezelfde reden bij.
 *
 * De topic-hashes zijn keccak256 van de signatuur. test/dex-pools.js rekent ze
 * na, zodat een typfout niet stil nul resultaten oplevert.
 */

export const PATTERNS = [
  {
    // UniswapV2Factory en alle forks (Sushi, Pancake v2, ...)
    topic: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
    sig: 'PairCreated(address,address,address,uint256)',
    dex: 'Uniswap v2-fork',
  },
  {
    // UniswapV3Factory en forks. Let op: data-woord 0 is tickSpacing, niet de pool.
    topic: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    sig: 'PoolCreated(address,address,uint24,int24,address)',
    dex: 'Uniswap v3-fork',
  },
  {
    // Uniswap v4 PoolManager: pool-ID in plaats van een pool-adres.
    topic: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
    sig: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
    dex: 'Uniswap v4',
  },
  {
    // Aerodrome / Velodrome v2 (stable is geindexeerd)
    topic: '0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e',
    sig: 'PoolCreated(address,address,bool,address,uint256)',
    dex: 'Solidly-fork',
  },
  {
    // Solidly / Velodrome v1 (stable soms wel, soms niet geindexeerd)
    topic: '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9',
    sig: 'PairCreated(address,address,bool,address,uint256)',
    dex: 'Solidly-fork',
  },
  {
    // Slipstream (Aerodrome concentrated liquidity)
    topic: '0xab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2',
    sig: 'PoolCreated(address,address,int24,address)',
    dex: 'Slipstream-fork',
  },
  {
    // Algebra (Camelot v3, QuickSwap v3, ...)
    topic: '0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db',
    sig: 'Pool(address,address,address)',
    dex: 'Algebra-fork',
  },
];

const BY_TOPIC = new Map(PATTERNS.map((p) => [p.topic, p]));
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * De chains die we afzoeken. De sleutel is ook de naam voor evmCall, dus de
 * RPC's staan in evm.js en zijn te overrulen met EVM_RPC_<SLEUTEL>.
 *
 * grain: de blokstand wordt hierop afgerond, zodat pool-blocks.json ruwweg
 *   eens per uur verandert en niet bij elke run (commit-ruis).
 * chunk: maximaal bereik per eth_getLogs-call.
 * lookback: hoe ver we terugkijken als we een chain voor het eerst zien.
 * maxLag: loopt de scanner verder achter dan dit, dan springt hij vooruit.
 *   Een pool van een dag geleden is geen nieuws meer, en zonder sprong haalt
 *   een snelle chain een achterstand nooit meer in.
 */
export const CHAINS = [
  {
    key: 'robinhood', name: 'Robinhood Chain', chainId: 4663,
    native: 'ETH', explorer: 'https://robinhoodchain.blockscout.com',
    // ~0,1 s per blok: 36.000 blokken per uur.
    grain: 36000, chunk: 10000, lookback: 36000, maxLag: 900000,
  },
  {
    key: 'arc', name: 'Arc', chainId: 5042,
    native: 'USDC', explorer: 'https://explorer.arc.io',
    grain: 5000, chunk: 5000, lookback: 7000, maxLag: 170000,
  },
  {
    key: 'elysium', name: 'Elysium', chainId: 1339,
    native: 'LAVA', explorer: 'https://blockscout.elysiumchain.tech',
    grain: 500, chunk: 2000, lookback: 600, maxLag: 15000,
  },
  {
    // Mainnet is nog besloten (whitelist). Zet aan met DEX_POOL_CHAINS zodra
    // de publieke RPC er is; de watchlist meldt dat moment.
    key: 'giwa', name: 'GIWA', chainId: null, enabled: false,
    native: 'ETH', explorer: null,
    grain: 3600, chunk: 5000, lookback: 3600, maxLag: 90000,
  },
];

/** Welke chains aan staan: DEX_POOL_CHAINS=robinhood,arc overrulet de standaard. */
export function activeChains(env = process.env) {
  const list = String(env.DEX_POOL_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return CHAINS.filter((c) => list.includes(c.key));
  return CHAINS.filter((c) => c.enabled !== false);
}

/**
 * Leest één logbericht uit tot { dex, pool, token0, token1, ... }.
 * Geeft null bij iets wat we niet herkennen: liever niets dan een verkeerd adres.
 */
export function parsePoolLog(log) {
  const p = BY_TOPIC.get(String(log?.topics?.[0] || '').toLowerCase());
  if (!p) return null;
  const topics = log.topics;
  const words = addressWords(log.data);
  const out = { dex: p.dex, sig: p.sig, emitter: String(log.address || '').toLowerCase() };

  switch (p.sig) {
    case 'PairCreated(address,address,address,uint256)':
      Object.assign(out, { token0: topicToAddress(topics[1]), token1: topicToAddress(topics[2]), pool: words[0] });
      break;
    case 'PoolCreated(address,address,uint24,int24,address)':
      // topics[3] is fee; data = [tickSpacing, pool]
      Object.assign(out, {
        token0: topicToAddress(topics[1]), token1: topicToAddress(topics[2]),
        pool: words[1], fee: hexToNum(topics[3]),
      });
      break;
    case 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)':
      // topics = [sig, id, currency0, currency1]; data = [fee, tickSpacing, hooks, sqrtPrice, tick]
      Object.assign(out, {
        poolId: topics[1] ? String(topics[1]).toLowerCase() : null,
        token0: topicToAddress(topics[2]), token1: topicToAddress(topics[3]),
        pool: null, fee: hexToNum(`0x${String(log.data || '').replace(/^0x/, '').slice(0, 64)}`),
        hooks: words[2] && words[2] !== ZERO ? words[2] : null,
      });
      break;
    case 'PoolCreated(address,address,bool,address,uint256)':
    case 'PairCreated(address,address,bool,address,uint256)':
      // Met 'stable' geindexeerd (4 topics) is de pool data-woord 0, anders woord 1.
      Object.assign(out, {
        token0: topicToAddress(topics[1]), token1: topicToAddress(topics[2]),
        pool: topics.length >= 4 ? words[0] : words[1],
      });
      break;
    case 'PoolCreated(address,address,int24,address)':
    case 'Pool(address,address,address)':
      Object.assign(out, { token0: topicToAddress(topics[1]), token1: topicToAddress(topics[2]), pool: words[0] });
      break;
    default:
      return null;
  }
  if (!out.token0 || !out.token1) return null;
  if (!out.pool && !out.poolId) return null;
  return out;
}

/**
 * Leest een ABI-gecodeerde string, of een bytes32 (oude tokens als MKR).
 * Symbolen komen van wie het token uitrolde, dus: ingekort en zonder
 * stuurtekens. HTML-escaping gebeurt in notify.
 */
export function decodeSymbol(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (!h || !/^[0-9a-f]*$/i.test(h)) return null;
  let bytes;
  if (h.length >= 128) {
    const len = Number.parseInt(h.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 256 || 128 + len * 2 > h.length) return null;
    bytes = Buffer.from(h.slice(128, 128 + len * 2), 'hex');
  } else if (h.length === 64) {
    bytes = Buffer.from(h, 'hex');
    const end = bytes.indexOf(0);
    if (end >= 0) bytes = bytes.subarray(0, end);
  } else {
    return null;
  }
  const s = bytes.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return s ? s.slice(0, 32) : null;
}

/** Zoekt een chain af tot aan de top, in stukken, binnen het tijdsbudget. */
async function scanChain(chain, previous, deadline) {
  const latest = hexToNum(await evmCall(chain.key, 'eth_blockNumber'));
  if (!Number.isFinite(latest)) throw new Error('geen blokhoogte');

  let from = Number.isFinite(previous)
    ? previous
    : checkpoint(Math.max(0, latest - chain.lookback), chain.grain);
  let skipped = 0;
  if (latest - from > chain.maxLag) {
    const jump = checkpoint(Math.max(0, latest - chain.lookback), chain.grain);
    skipped = jump - from;
    from = jump;
  }

  const logs = [];
  let reached = from;
  while (reached <= latest && Date.now() < deadline) {
    const to = Math.min(latest, reached + chain.chunk - 1);
    const res = await evmCall(chain.key, 'eth_getLogs', [
      { fromBlock: numToHex(reached), toBlock: numToHex(to), topics: [PATTERNS.map((p) => p.topic)] },
    ]);
    if (Array.isArray(res)) logs.push(...res);
    reached = to + 1;
  }
  // Pas na een geslaagde call opschuiven, en alleen tot waar we echt kwamen.
  const cursor = reached > from ? checkpoint(reached - 1, chain.grain) : from;
  return { logs, cursor, skipped, latest, reached };
}

function toRecord(chain, log) {
  const p = parsePoolLog(log);
  if (!p) return null;
  const id = p.pool || p.poolId;
  const url = chain.explorer
    ? p.pool ? `${chain.explorer}/address/${p.pool}` : `${chain.explorer}/tx/${log.transactionHash}`
    : null;
  return {
    key: `pool:${chain.key}:${log.transactionHash}:${hexToNum(log.logIndex)}`,
    source: 'dex-pools',
    name: `Nieuwe pool op ${chain.name}`,
    nameKey: `pool:${chain.key}:${id}`,
    kind: 'pool',
    ecosystem: chain.name,
    chainId: chain.chainId,
    poolChain: chain.key,
    native: chain.native,
    dex: p.dex,
    pool: p.pool,
    poolId: p.poolId || null,
    token0: p.token0,
    token1: p.token1,
    fee: Number.isFinite(p.fee) ? p.fee : null,
    hooks: p.hooks || null,
    emitter: p.emitter,
    block: hexToNum(log.blockNumber),
    tx: chain.explorer ? `${chain.explorer}/tx/${log.transactionHash}` : log.transactionHash,
    tokenUrl0: chain.explorer && p.token0 !== ZERO ? `${chain.explorer}/token/${p.token0}` : null,
    tokenUrl1: chain.explorer && p.token1 !== ZERO ? `${chain.explorer}/token/${p.token1}` : null,
    url: url || log.transactionHash,
    rpc: [], explorers: [], faucets: [],
  };
}

export default {
  id: 'dex-pools',
  label: 'Nieuwe DEX-pools op gekozen chains',
  url: 'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/factory',

  async fetchAll() {
    const chains = activeChains();
    if (!chains.length) return [];
    const blocks = await loadPoolBlocks();
    const before = JSON.stringify(blocks);
    const budgetMs = Number(process.env.DEX_POOL_BUDGET_SECONDS || 40) * 1000;
    const deadline = Date.now() + budgetMs;
    const out = [];
    const failures = [];

    // Achter elkaar, niet parallel: het budget is gedeeld en een trage chain
    // mag de andere niet verdringen. Elke chain krijgt een eerlijk deel.
    for (const [i, chain] of chains.entries()) {
      const share = Date.now() + (deadline - Date.now()) / (chains.length - i);
      try {
        const res = await scanChain(chain, blocks[chain.key], share);
        blocks[chain.key] = res.cursor;
        if (res.skipped > 0) {
          console.warn(`[dex-pools] ${chain.key}: ${res.skipped} blokken overgeslagen (achterstand > maxLag)`);
        }
        if (res.reached <= res.latest) {
          console.warn(`[dex-pools] ${chain.key}: nog ${res.latest - res.reached + 1} blokken te gaan, volgende run verder`);
        }
        for (const log of res.logs) {
          const r = toRecord(chain, log);
          if (r) out.push(r);
        }
      } catch (e) {
        failures.push(`${chain.key}: ${e.message}`);
      }
    }

    if (JSON.stringify(blocks) !== before) await savePoolBlocks(blocks);
    if (failures.length === chains.length) {
      throw new Error(`alle chains onbereikbaar — ${failures.join('; ')}`);
    }
    if (failures.length) console.warn(`[dex-pools] ${failures.join('; ')}`);
    return out;
  },

  /**
   * Alleen voor nieuwe pools: tokensymbolen ophalen, zodat het bericht
   * "PEPE/WETH" zegt in plaats van twee kale adressen. Best-effort: een token
   * zonder symbol() blijft gewoon als adres staan.
   */
  async enrich(fresh) {
    const deadline = Date.now() + Number(process.env.DEX_POOL_SYMBOL_SECONDS || 20) * 1000;
    const cache = new Map();
    const symbolOf = async (chainKey, native, addr) => {
      if (addr === ZERO) return native;
      const k = `${chainKey}:${addr}`;
      if (cache.has(k)) return cache.get(k);
      let sym = null;
      if (Date.now() < deadline) {
        try {
          const res = await evmCall(chainKey, 'eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest'], { timeout: 5000 });
          sym = decodeSymbol(res);
        } catch { /* geen symbool, dan het adres */ }
      }
      cache.set(k, sym);
      return sym;
    };
    for (const r of fresh) {
      r.symbol0 = await symbolOf(r.poolChain, r.native, r.token0);
      r.symbol1 = await symbolOf(r.poolChain, r.native, r.token1);
      const a = r.symbol0 || `${r.token0.slice(0, 8)}…`;
      const b = r.symbol1 || `${r.token1.slice(0, 8)}…`;
      r.name = `${a} / ${b} op ${r.ecosystem}`;
    }
    return fresh;
  },
};
