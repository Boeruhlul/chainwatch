import { getJson } from '../http.js';
import { nameKey } from '../util.js';
import { evmCall, hexToNum } from '../evm.js';

/**
 * Nieuwe, nog naamloze afzenders van blob-data op Ethereum.
 *
 * Een rollup die daadwerkelijk draait MOET zijn data naar Ethereum schrijven,
 * anders is hij geen rollup. Dat gebeurt vanaf een vast adres, de batcher.
 * Blobscan houdt bij welke adressen dat doen en plakt er een naam op zodra
 * bekend is van wie ze zijn. Een adres dat regelmatig blobs post en nog geen
 * naam heeft, is dus een draaiende chain die niemand heeft thuisgebracht.
 *
 * Dit is de tegenhanger van de fabrieksbron: die ziet een rollup bij het
 * uitrollen, deze ziet hem zodra hij echt produceert — en hij is niet
 * afhankelijk van welke technologie eronder zit.
 */

const API = 'https://api.blobscan.com/transactions';

/** Hoe vaak een adres in het venster moet posten voordat we het serieus nemen. */
const MIN_TXS = Number(process.env.BLOB_MIN_TXS || 3);
const PAGE_SIZE = Number(process.env.BLOB_PAGE_SIZE || 100);

/**
 * Boven dit aantal verstuurde transacties is een afzender geen nieuwkomer.
 *
 * Aanleiding: Aztec heeft gedecentraliseerde sequencers die elk vanaf een eigen
 * adres posten, en Blobscan labelt die niet. Zo'n proposer had al 26.000+
 * transacties op zijn naam en kwam hier toch binnen als "naamloze rollup".
 * Een echte nieuwe batcher begint vrijwel altijd op een vers adres. Ook een
 * snelle (één batch per minuut) zit pas na ~17 uur op 1000.
 */
const MAX_NONCE = Number(process.env.BLOB_MAX_NONCE || 1000);

/** Telt afzenders zonder rollup-label en houdt de regelmatige over. */
export function unlabelledSubmitters(transactions, { minTxs = MIN_TXS } = {}) {
  const byAddress = new Map();
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    const from = String(tx?.from || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(from)) continue;
    // Een adres mét label is al thuisgebracht; daar is niets nieuws aan.
    if (tx?.rollup) continue;
    const entry = byAddress.get(from) || { from, count: 0, newest: null, blockNumber: null, hash: null };
    entry.count++;
    const ts = tx?.blockTimestamp || null;
    if (ts && (!entry.newest || ts > entry.newest)) {
      entry.newest = ts;
      entry.blockNumber = tx?.blockNumber ?? null;
      entry.hash = tx?.hash || null;
    }
    byAddress.set(from, entry);
  }
  return [...byAddress.values()].filter((e) => e.count >= minTxs);
}

/**
 * Laat afzenders met een lange geschiedenis vallen.
 *
 * getNonce is injecteerbaar voor de tests. Faalt de opvraag, dan blijft het
 * record staan: een gemiste chain weegt zwaarder dan een alert te veel.
 */
export async function dropVeterans(records, getNonce, { maxNonce = MAX_NONCE } = {}) {
  const out = [];
  for (const r of records) {
    let nonce = null;
    try {
      nonce = await getNonce(r.contract);
    } catch (e) {
      console.warn(`[blob-submitters] nonce van ${r.contract} onbekend (${e.message}), record blijft staan`);
    }
    if (Number.isFinite(nonce) && nonce > maxNonce) {
      console.log(`[blob-submitters] ${r.contract} overgeslagen: al ${nonce} transacties`);
      continue;
    }
    out.push(Number.isFinite(nonce) ? { ...r, senderNonce: nonce } : r);
  }
  return out;
}

const rpcNonce = async (address) =>
  hexToNum(await evmCall('ethereum', 'eth_getTransactionCount', [address, 'latest'], { timeout: 10000 }));

export default {
  id: 'blob-submitters',
  label: 'Naamloze blob-afzenders op Ethereum',
  url: 'https://blobscan.com',

  async fetchAll() {
    const res = await getJson(`${API}?ps=${PAGE_SIZE}`, { timeout: 25000 });
    const txs = Array.isArray(res) ? res : res?.transactions;
    if (!Array.isArray(txs)) throw new Error('onverwacht formaat: geen transactielijst');

    return unlabelledSubmitters(txs).map((e) => ({
      key: `blob:${e.from}`,
      source: 'blob-submitters',
      name: `Naamloze rollup ${e.from.slice(0, 10)}…`,
      nameKey: nameKey(`blob${e.from}`, 'mainnet'),
      kind: 'stealth',
      stealthKind: 'blob',
      ecosystem: 'EVM (rollup op Ethereum)',
      chainId: null,
      rpc: [],
      explorers: [],
      faucets: [],
      contract: e.from,
      batchCount: e.count,
      lastSeenAt: e.newest,
      block: e.blockNumber,
      deployTx: e.hash ? `https://etherscan.io/tx/${e.hash}` : null,
      url: `https://blobscan.com/address/${e.from}`,
    }));
  },

  /** Alleen voor nieuwe adressen: één RPC-call per afzender, ooit. */
  async enrich(fresh) {
    return dropVeterans(fresh, rpcNonce);
  },
};
