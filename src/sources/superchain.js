import { getJson } from '../http.js';
import { classify, nameKey, uniq } from '../util.js';

const URL = 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/chainList.json';

/**
 * Superchain registry: elke OP Stack rollup die de Optimism-standaard volgt.
 * Een team registreert zijn chain hier tijdens de deploy, vaak voordat er een
 * chain-ID-aanvraag of publieke aankondiging is. De 'sepolia/'-identifiers
 * verschijnen soms weken voor het mainnet.
 */
export default {
  id: 'superchain',
  label: 'Superchain registry (OP Stack)',
  url: 'https://github.com/ethereum-optimism/superchain-registry',

  async fetchAll() {
    const list = await getJson(URL, { timeout: 30000 });
    if (!Array.isArray(list)) throw new Error('onverwacht formaat: geen array');

    return list.filter((c) => c && c.chainId != null).map((c) => {
      const identifier = String(c.identifier || '');
      const isTest = identifier.startsWith('sepolia') || identifier.startsWith('goerli');
      const kind = isTest ? 'testnet' : classify(c.name);
      const name = c.name || identifier || `chain ${c.chainId}`;
      return {
        key: `superchain:${c.chainId}`,
        source: 'superchain',
        name,
        nameKey: nameKey(name, kind),
        kind,
        ecosystem: 'EVM (OP Stack)',
        chainId: c.chainId,
        rpc: uniq(c.rpc || []).slice(0, 3),
        explorers: uniq(c.explorers || []).slice(0, 2),
        faucets: [],
        parent: c.parent?.chain || null,
        url: identifier
          ? `https://github.com/ethereum-optimism/superchain-registry/tree/main/superchain/configs/${identifier}`
          : 'https://github.com/ethereum-optimism/superchain-registry',
      };
    });
  },
};
