import { gh } from '../http.js';
import { nameKey } from '../util.js';

/**
 * L2BEAT volgt rollups en L2/L3s, inclusief projecten die nog niet live zijn.
 * We lezen de config-repo in plaats van de site-API: een nieuwe map onder
 * packages/config/src/projects verschijnt zodra L2BEAT een project begint te
 * volgen, vaak ruim voor mainnet launch.
 */
const SKIP = /^[._]|^(shared-|global|tvs|verifyConfigs)/;

export default {
  id: 'l2beat',
  label: 'L2BEAT tracked projects',
  url: 'https://l2beat.com',

  async fetchAll() {
    const entries = await gh('/repos/l2beat/l2beat/contents/packages/config/src/projects');
    if (!Array.isArray(entries)) throw new Error('onverwacht formaat: geen array');

    return entries
      .filter((e) => e.type === 'dir' && !SKIP.test(e.name))
      .map((e) => ({
        key: `l2beat:${e.name}`,
        source: 'l2beat',
        name: e.name,
        nameKey: nameKey(e.name, 'mainnet'),
        kind: 'upcoming',
        ecosystem: 'L2 / rollup',
        chainId: null,
        rpc: [],
        explorers: [],
        faucets: [],
        url: `https://l2beat.com/scaling/projects/${e.name}`,
      }));
  },
};
