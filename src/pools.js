import { hexToNum, topicToAddress, addressWords } from './evm.js';

/**
 * Herkenning van DEX-gebeurtenissen: PairCreated / PoolCreated / Initialize
 * van Uniswap-, Solidly-, Algebra- en v4-forks. Losgemaakt uit de oude
 * pool-scanner (sources/dex-pools.js, niet meer actief) zodat de
 * ecosysteem-scan dezelfde patronen gebruikt. De topic-hashes zijn keccak256
 * van de signatuur; test/ecosystem.js rekent ze na, zodat een typfout niet
 * stil nul resultaten oplevert.
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
