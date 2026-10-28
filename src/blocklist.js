import fs from 'node:fs/promises';
import path from 'node:path';
import { slug } from './util.js';
import { apexOf } from './enrich.js';
import { keysOf } from './dossiers.js';

/**
 * Blocklist: projecten die je als scam (of gewoon als oninteressant) hebt
 * aangemerkt. Bestand: data/blocklist.json, van jou; de bot schrijft er niet in.
 *
 * Een project wordt herkend op naam, chain ID, domein of GitHub-org, dezelfde
 * sleutels als de dossiers. Wat matcht krijgt geen alert, komt niet op de
 * wachtlijst, niet in de ecosysteem-scan en niet in het dagoverzicht. Het
 * wordt wel als gezien weggeschreven, zodat het ook later niet terugkomt.
 *
 * Bewust ook op domein en org: een team dat onder een nieuwe naam een nieuwe
 * chain ID aanvraagt met dezelfde website wordt zo ook overgeslagen.
 */

const DATA = process.env.CHAINWATCH_DATA || 'data';
export const BLOCKLIST_FILE = path.join(DATA, 'blocklist.json');

export function buildBlocklist(raw) {
  const keys = new Set();
  for (const p of raw?.projects || []) {
    if (p.enabled === false) continue;
    for (const n of [p.name, ...(p.aliases || [])]) {
      const s = slug(n).replace(/(testnet|devnet|localnet|mainnet|sepolia)+$/, '');
      if (s.length >= 3) keys.add(`n:${s}`);
    }
    for (const id of p.chainIds || []) keys.add(`id:${String(id).replace(/^eip155:/, '')}`);
    for (const d of p.domains || []) {
      const apex = apexOf(d);
      if (apex) keys.add(`d:${apex}`);
    }
    for (const g of p.github || []) keys.add(`gh:${String(g).toLowerCase()}`);
  }
  const hit = (ks) => [...ks].some((k) => keys.has(k));
  return {
    size: keys.size,
    keys,
    /** Detectie, wachtlijst-item of launch-record. */
    match(r) {
      if (!keys.size || !r) return false;
      const ks = keysOf(r);
      for (const u of [...(r.rpc || []), ...(r.explorers || []), r.liveRpc]) {
        const apex = apexOf(u);
        if (apex) ks.add(`d:${apex}`);
      }
      return hit(ks);
    },
    /** Dossier: op zijn opgebouwde sleutels. */
    matchDossier(d) {
      return keys.size > 0 && hit(d?.keys || []);
    },
  };
}

/** Ontbreekt = leeg. Corrupt = hard falen: anders komen scams stil terug. */
export async function loadBlocklist(file = BLOCKLIST_FILE) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return buildBlocklist({});
    throw new Error(`kan ${file} niet lezen: ${e.message}`);
  }
  try {
    return buildBlocklist(JSON.parse(raw));
  } catch (e) {
    throw new Error(`${file} is corrupt (${e.message}); herstel het bestand`);
  }
}
