import { getJson } from '../http.js';
import { classify, nameKey, uniq } from '../util.js';

/**
 * ethereum-lists/chains via chainid.network.
 * Dit is de bron achter chainlist.org: elke EVM chain die een chain ID registreert
 * staat hier, mainnet en testnet. Dekt verreweg de meeste nieuwe netwerken.
 */
export default {
  id: 'chainlist',
  label: 'Chainlist (ethereum-lists)',
  url: 'https://chainid.network/chains.json',

  async fetchAll() {
    const chains = await getJson('https://chainid.network/chains.json', { timeout: 45000 });
    if (!Array.isArray(chains)) throw new Error('onverwacht formaat: geen array');

    return chains
      .filter((c) => c && c.chainId != null && c.status !== 'deprecated')
      .map((c) => {
        const kind = c.status === 'incubating' ? 'upcoming' : classify(c.name || c.title, { faucets: c.faucets });
        const name = c.name || c.title || `chain ${c.chainId}`;
        return {
          key: `evm:${c.chainId}`,
          source: 'chainlist',
          name,
          nameKey: nameKey(name, kind),
          kind,
          ecosystem: 'EVM',
          chainId: c.chainId,
          nativeCurrency: c.nativeCurrency?.symbol || null,
          rpc: uniq((c.rpc || []).filter((u) => typeof u === 'string' && !u.includes('${'))).slice(0, 4),
          explorers: uniq((c.explorers || []).map((e) => e?.url)).slice(0, 2),
          faucets: uniq(c.faucets || []).slice(0, 3),
          // infoURL is het startpunt voor de socials-verrijking.
          website: typeof c.infoURL === 'string' ? c.infoURL : null,
          url: `https://chainlist.org/chain/${c.chainId}`,
          parent: c.parent?.chain || null,
        };
      });
  },
};
