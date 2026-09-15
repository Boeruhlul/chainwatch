import { gh } from '../http.js';
import { nameKey } from '../util.js';

/**
 * cosmos/chain-registry: de canonieke lijst van Cosmos SDK chains.
 * Mainnets staan in de root, testnets onder testnets/, devnets onder devnets/.
 * Een nieuwe map betekent dat een chain genesis-klaar is.
 */
const SKIP = /^[._]/;

async function listDir(path, kind) {
  const entries = await gh(`/repos/cosmos/chain-registry/contents/${path}`);
  if (!Array.isArray(entries)) throw new Error(`onverwacht formaat voor ${path || 'root'}`);
  return entries
    .filter((e) => e.type === 'dir' && !SKIP.test(e.name))
    .map((e) => ({
      key: `cosmos:${path ? `${path}/` : ''}${e.name}`,
      source: 'cosmos',
      name: e.name,
      nameKey: nameKey(e.name, kind),
      kind,
      ecosystem: 'Cosmos',
      chainId: null,
      rpc: [],
      explorers: [],
      faucets: [],
      url: `https://github.com/cosmos/chain-registry/tree/master/${path ? `${path}/` : ''}${e.name}`,
    }));
}

export default {
  id: 'cosmos',
  label: 'Cosmos chain-registry',
  url: 'https://github.com/cosmos/chain-registry',

  async fetchAll() {
    const [main, test] = await Promise.all([listDir('', 'mainnet'), listDir('testnets', 'testnet')]);
    // devnets/ bestaat niet altijd; faal daar niet op
    let dev = [];
    try {
      dev = await listDir('devnets', 'devnet');
    } catch {
      /* map ontbreekt, geen probleem */
    }
    return [...main, ...test, ...dev];
  },
};
