import { evmCall, hexToNum, numToHex, topicToAddress, addressWords } from '../evm.js';
import { loadBlocks, saveBlocks } from '../store.js';
import { nameKey } from '../util.js';

/**
 * Nieuwe rollups op het moment dat ze worden uitgerold.
 *
 * Dit is het enige signaal in de hele tool dat niet afhangt van de bereidheid
 * van een team om iets bekend te maken. Een Arbitrum-chain KAN niet bestaan
 * zonder via het fabriekscontract op zijn moederketen te worden aangemaakt, en
 * dat laat een openbaar logbericht achter met de contracten erin. Stil
 * uitrollen en later pas aankondigen verandert daar niets aan.
 *
 * We filteren bewust niet op de handtekening van de gebeurtenis: die is per
 * versie van de fabriek anders, en een verkeerd gehashte handtekening zou stil
 * nul resultaten geven. Elk logbericht van de fabriek is interessant genoeg.
 */

const FACTORIES = [
  {
    key: 'orbit-ethereum',
    chain: 'ethereum',
    address: '0x43698080f40dB54DEE6871540037b8AB8fD0AB44',
    label: 'Arbitrum (op Ethereum)',
    explorer: 'https://etherscan.io',
  },
  {
    key: 'orbit-arbitrum',
    chain: 'arbitrum',
    address: '0xB90e53fd945Cd28Ec4728cBfB566981dD571eB8b',
    label: 'Arbitrum (op Arbitrum One)',
    explorer: 'https://arbiscan.io',
  },
  {
    key: 'orbit-base',
    chain: 'base',
    address: '0xDbe3e840569a0446CDfEbc65D7d429c5Da5537b7',
    label: 'Arbitrum (op Base)',
    explorer: 'https://basescan.org',
  },
];

/**
 * De bewaarde blokstand wordt naar beneden afgerond op een veelvoud hiervan.
 *
 * Zou je het exacte laatst gescande blok opslaan, dan verandert blocks.json bij
 * elke run en commit de workflow zichzelf suf — dezelfde val als bij de
 * wachtlijst. Met een grove stand verandert het bestand pas als de keten een
 * grens passeert, en het overlappende stuk dat daardoor opnieuw wordt
 * afgezocht vangt de seen-set gewoon op. Geen gemiste blokken, geen ruis.
 */
const GRAIN = { ethereum: 1000, arbitrum: 20000, base: 5000 };
// Hoe ver we terugkijken als we een keten voor het eerst zien.
const FIRST_LOOKBACK = { ethereum: 5000, arbitrum: 200000, base: 50000 };
// Bovengrens per run: publieke endpoints weigeren grote bereiken.
const MAX_RANGE = { ethereum: 10000, arbitrum: 100000, base: 50000 };

/** Rondt een blokstand naar beneden af op de grofheid van die keten. */
export function checkpoint(block, grain) {
  if (!Number.isFinite(block) || !Number.isFinite(grain) || grain <= 0) return 0;
  return Math.max(0, Math.floor(block / grain) * grain);
}

/**
 * De niet-geindexeerde velden van RollupCreated, op volgorde:
 *   inbox, outbox, rollupEventInbox, challengeManager, adminProxy,
 *   sequencerInbox, bridge, upgradeExecutor, validatorWalletCreator
 *
 * De sequencerInbox is de belangrijkste: daarin staat elke batch die de chain
 * ooit naar zijn moederketen heeft geschreven. Wie die heeft kan de chain
 * volledig uitlezen — en zelfs een eigen node draaien — zonder ooit de RPC van
 * het team nodig te hebben. Dat is precies het gat dat een aankondiging moet
 * dichten, en dat hier al openligt.
 */
const EVENT_FIELDS = [
  'inbox', 'outbox', 'rollupEventInbox', 'challengeManager', 'adminProxy',
  'sequencerInbox', 'bridge', 'upgradeExecutor', 'validatorWalletCreator',
];

function contractsFrom(log) {
  const words = addressWords(log?.data);
  const out = {};
  for (const [i, name] of EVENT_FIELDS.entries()) {
    if (words[i]) out[name] = words[i];
  }
  return out;
}

/** Wie heeft dit uitgerold? Vaak het enige spoor naar wie erachter zit. */
async function deployerOf(chain, txHash) {
  try {
    const tx = await evmCall(chain, 'eth_getTransactionByHash', [txHash]);
    return typeof tx?.from === 'string' ? tx.from.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** chainId() op het rollup-contract; best-effort, want niet elke versie heeft het. */
async function chainIdOf(chain, rollupAddress) {
  try {
    const res = await evmCall(chain, 'eth_call', [
      { to: rollupAddress, data: '0x9a8a0592' }, // chainId()
      'latest',
    ]);
    const n = hexToNum(res);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export default {
  id: 'rollup-factory',
  label: 'Rollup-fabrieken op de moederketens',
  url: 'https://docs.arbitrum.io/launch-arbitrum-chain/deploy/canonical-factory-contracts',

  async fetchAll() {
    const blocks = await loadBlocks();
    const before = { ...blocks };
    const out = [];
    const failures = [];

    for (const f of FACTORIES) {
      try {
        const latest = hexToNum(await evmCall(f.chain, 'eth_blockNumber'));
        if (!Number.isFinite(latest)) throw new Error('geen blokhoogte');

        const grain = GRAIN[f.chain] || 1000;
        const previous = blocks[f.key];
        // Vanaf de bewaarde grove stand, dus met overlap. Dubbele treffers zijn
        // gratis: die staan al in de seen-set.
        const from = Number.isFinite(previous)
          ? previous
          : checkpoint(Math.max(0, latest - (FIRST_LOOKBACK[f.chain] || 5000)), grain);
        const to = Math.min(latest, from + (MAX_RANGE[f.chain] || 10000));
        if (to < from) continue;

        const logs = await evmCall(f.chain, 'eth_getLogs', [
          { address: f.address, fromBlock: numToHex(from), toBlock: numToHex(to) },
        ]);

        // Pas bijwerken als de call gelukt is: een mislukte keten mag geen
        // blokken overslaan, anders missen we de rollups die daarin zaten.
        blocks[f.key] = checkpoint(to, grain);

        for (const log of Array.isArray(logs) ? logs : []) {
          const rollup = topicToAddress(log.topics?.[1]);
          if (!rollup) continue;
          const chainId = await chainIdOf(f.chain, rollup);
          const contracts = contractsFrom(log);
          const deployer = await deployerOf(f.chain, log.transactionHash);
          const name = chainId ? `Nieuwe rollup (chain ID ${chainId})` : `Nieuwe rollup ${rollup.slice(0, 10)}…`;
          out.push({
            key: `factory:${f.key}:${log.transactionHash}:${log.logIndex}`,
            source: 'rollup-factory',
            name,
            nameKey: nameKey(chainId ? `rollup${chainId}` : rollup, 'proposal'),
            kind: 'stealth',
            stealthKind: 'factory',
            ecosystem: 'EVM (Arbitrum Orbit)',
            chainId,
            rpc: [],
            explorers: [],
            faucets: [],
            parentLabel: f.label,
            contract: rollup,
            contracts,
            sequencerInbox: contracts.sequencerInbox || null,
            deployer,
            deployerUrl: deployer ? `${f.explorer}/address/${deployer}` : null,
            deployTx: `${f.explorer}/tx/${log.transactionHash}`,
            url: `${f.explorer}/address/${rollup}`,
            block: hexToNum(log.blockNumber),
          });
        }
      } catch (e) {
        failures.push(`${f.key}: ${e.message}`);
      }
    }

    // Alleen schrijven als er echt iets verschoven is, anders is de I/O en de
    // mogelijke commit voor niets.
    if (JSON.stringify(blocks) !== JSON.stringify(before)) await saveBlocks(blocks);

    // Alle drie de ketens onbereikbaar is een echte storing; eentje die hapert
    // mag de bron niet laten omvallen, want de andere twee leveren nog wel.
    if (failures.length === FACTORIES.length) {
      throw new Error(`alle moederketens onbereikbaar — ${failures.join('; ')}`);
    }
    if (failures.length) console.warn(`[rollup-factory] ${failures.join('; ')}`);
    return out;
  },
};
