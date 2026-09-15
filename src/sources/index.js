import chainlist from './chainlist.js';
import ethlistsPr from './ethlists-pr.js';
import defillama from './defillama.js';
import l2beat from './l2beat.js';
import cosmos from './cosmos.js';
import coingecko from './coingecko.js';

const REAL_SOURCES = [chainlist, ethlistsPr, defillama, l2beat, cosmos, coingecko];

/**
 * Testhaak: met CHAINWATCH_FIXTURE=<pad> draait de watcher tegen een lokaal
 * JSON-bestand in plaats van het netwerk. Wordt alleen door de tests gebruikt.
 */
function fixtureSource(file) {
  return {
    id: 'fixture',
    label: 'fixture',
    url: 'file://' + file,
    async fetchAll() {
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw === 'BOOM') throw new Error('gesimuleerde bronfout');
      const { classify, nameKey, uniq } = await import('../util.js');
      return raw.map((c) => {
        const kind = c.status === 'incubating' ? 'upcoming' : classify(c.name, { faucets: c.faucets });
        return {
          key: `evm:${c.chainId}`, source: 'fixture', name: c.name,
          nameKey: nameKey(c.name, kind), kind, ecosystem: 'EVM', chainId: c.chainId,
          rpc: uniq(c.rpc || []), explorers: [], faucets: uniq(c.faucets || []),
          url: `https://chainlist.org/chain/${c.chainId}`, status: c.status,
        };
      }).filter((c) => c.status !== 'deprecated');
    },
  };
}

export const ALL_SOURCES = process.env.CHAINWATCH_FIXTURE
  ? [fixtureSource(process.env.CHAINWATCH_FIXTURE)]
  : REAL_SOURCES;

export function activeSources(disabled = []) {
  const off = new Set(disabled.map((s) => s.trim()).filter(Boolean));
  return ALL_SOURCES.filter((s) => !off.has(s.id));
}
