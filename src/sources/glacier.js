import { getJson } from '../http.js';
import { classify, nameKey } from '../util.js';

const URL = 'https://glacier-api.avax.network/v1/chains';

/**
 * Avalanche Glacier: alle L1's/subnets, inclusief testnets. Subnets worden
 * nergens anders systematisch bijgehouden — chainid.network kent ze pas als
 * het team een EVM chain ID aanvraagt, wat lang niet iedereen doet.
 */
export default {
  id: 'glacier',
  label: 'Avalanche L1s (Glacier)',
  url: 'https://subnets.avax.network',

  async fetchAll() {
    const res = await getJson(URL, { timeout: 30000 });
    const chains = res?.chains;
    if (!Array.isArray(chains)) throw new Error('onverwacht formaat: chains is geen array');

    return chains
      .filter((c) => c && c.chainId != null && c.private !== true)
      .map((c) => {
        const name = c.chainName || `chain ${c.chainId}`;
        const kind = c.isTestnet === true ? 'testnet' : classify(name);
        return {
          key: `avax:${c.chainId}`,
          source: 'glacier',
          name,
          nameKey: nameKey(name, kind),
          kind,
          ecosystem: 'Avalanche',
          chainId: c.chainId,
          nativeCurrency: c.networkToken?.symbol || null,
          rpc: c.rpcUrl ? [c.rpcUrl] : [],
          explorers: c.explorerUrl ? [c.explorerUrl] : [],
          faucets: [],
          description: c.description || null,
          url: c.explorerUrl || `https://subnets.avax.network/subnets/${c.subnetId || ''}`,
        };
      });
  },
};
