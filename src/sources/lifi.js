import { getJson } from '../http.js';
import { classify, nameKey, uniq } from '../util.js';

const URL = 'https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM';

/**
 * LI.FI bridge-aggregator. Een chain komt hier binnen zodra er liquiditeit en
 * een brug is — dat is meestal exact het moment waarop hij bruikbaar wordt,
 * en vaak eerder dan een TVL-notering bij DefiLlama.
 */
export default {
  id: 'lifi',
  label: 'LI.FI ondersteunde chains',
  url: 'https://li.fi',

  async fetchAll() {
    const res = await getJson(URL, { timeout: 30000 });
    const chains = res?.chains;
    if (!Array.isArray(chains)) throw new Error('onverwacht formaat: chains is geen array');

    return chains.filter((c) => c && c.id != null).map((c) => {
      const name = c.name || c.key || `chain ${c.id}`;
      const kind = c.mainnet === false ? 'testnet' : classify(name);
      return {
        key: `lifi:${c.chainType || 'EVM'}:${c.id}`,
        source: 'lifi',
        name,
        nameKey: nameKey(name, kind),
        kind,
        ecosystem: c.chainType || 'EVM',
        chainId: c.id,
        nativeCurrency: c.nativeToken?.symbol || c.coin || null,
        rpc: uniq(c.metamask?.rpcUrls || []).slice(0, 2),
        explorers: uniq(c.metamask?.blockExplorerUrls || []).slice(0, 2),
        faucets: [],
        url: (c.metamask?.blockExplorerUrls || [])[0] || 'https://li.fi',
      };
    });
  },
};
