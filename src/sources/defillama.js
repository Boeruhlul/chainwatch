import { getJson } from '../http.js';
import { classify, nameKey } from '../util.js';

/**
 * DefiLlama kent ~1000 chains en voegt een chain toe zodra er het eerste protocol
 * met TVL op draait. Vangt non-EVM chains die niet in ethereum-lists staan
 * (Solana-achtigen, Move chains, appchains).
 */
export default {
  id: 'defillama',
  label: 'DefiLlama chains',
  url: 'https://defillama.com/chains',

  async fetchAll() {
    const chains = await getJson('https://api.llama.fi/v2/chains');
    if (!Array.isArray(chains)) throw new Error('onverwacht formaat: geen array');

    return chains
      .filter((c) => c && c.name)
      .map((c) => {
        const kind = classify(c.name);
        return {
          key: `llama:${c.name}`,
          source: 'defillama',
          name: c.name,
          nameKey: nameKey(c.name, kind),
          kind,
          ecosystem: c.chainId ? 'EVM' : 'onbekend',
          chainId: c.chainId ?? null,
          nativeCurrency: c.tokenSymbol || null,
          rpc: [],
          explorers: [],
          faucets: [],
          url: `https://defillama.com/chain/${encodeURIComponent(c.name)}`,
          tvl: typeof c.tvl === 'number' ? Math.round(c.tvl) : null,
        };
      });
  },
};
