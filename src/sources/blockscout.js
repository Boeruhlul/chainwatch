import { getJson } from '../http.js';
import { classify, nameKey, uniq } from '../util.js';

const URL = 'https://chains.blockscout.com/api/chains';

/**
 * Blockscout-explorerregister. Een nieuw netwerk zet bijna altijd eerst een
 * explorer neer — vaak voordat het in chain-registers staat. Levert bovendien
 * als enige bron standaard een 'website'-veld, wat de socials-verrijking
 * meteen een startpunt geeft.
 */
export default {
  id: 'blockscout',
  label: 'Blockscout chains',
  url: 'https://chains.blockscout.com',

  async fetchAll() {
    const obj = await getJson(URL, { timeout: 30000 });
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('onverwacht formaat: geen object');
    }

    return Object.entries(obj).map(([id, c]) => {
      const name = c?.name || `chain ${id}`;
      const kind = c?.isTestnet === true ? 'testnet' : classify(name);
      const explorers = uniq((c?.explorers || []).map((e) => e?.url)).slice(0, 2);
      return {
        key: `blockscout:${id}`,
        source: 'blockscout',
        name,
        nameKey: nameKey(name, kind),
        kind,
        ecosystem: c?.rollupType ? `EVM (${c.rollupType})` : 'EVM',
        chainId: Number(id) || id,
        nativeCurrency: c?.native_currency || null,
        rpc: [],
        explorers,
        faucets: [],
        website: c?.website || null,
        parent: c?.settlementLayerChainId ? `eip155-${c.settlementLayerChainId}` : null,
        description: c?.description || null,
        url: explorers[0] || c?.website || 'https://chains.blockscout.com',
      };
    });
  },
};
