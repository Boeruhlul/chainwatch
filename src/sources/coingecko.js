import { getJson } from '../http.js';
import { classify, nameKey } from '../util.js';

/**
 * CoinGecko asset platforms. Een chain krijgt hier een entry zodra er tokens
 * op genoteerd worden. Vangt non-EVM L1s (Sui, Aptos, Solana-achtigen) en is
 * een goede kruiscontrole op DefiLlama.
 */
export default {
  id: 'coingecko',
  label: 'CoinGecko asset platforms',
  url: 'https://www.coingecko.com',

  async fetchAll() {
    const platforms = await getJson('https://api.coingecko.com/api/v3/asset_platforms');
    if (!Array.isArray(platforms)) throw new Error('onverwacht formaat: geen array');

    return platforms
      .filter((p) => p && p.id)
      .map((p) => {
        const name = p.name || p.id;
        const kind = classify(name);
        return {
          key: `cg:${p.id}`,
          source: 'coingecko',
          name,
          nameKey: nameKey(name, kind),
          kind,
          ecosystem: p.chain_identifier ? 'EVM' : 'onbekend',
          chainId: p.chain_identifier ?? null,
          nativeCurrency: p.native_coin_id || null,
          rpc: [],
          explorers: [],
          faucets: [],
          url: `https://www.coingecko.com/en/chains/${p.id}`,
        };
      });
  },
};
