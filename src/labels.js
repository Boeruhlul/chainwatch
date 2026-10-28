import { getText } from './http.js';

/**
 * Bekende adressen uit openbare labelsets, op runtime opgehaald.
 *
 * Dune Spellbook houdt met de hand bij welke Ethereum-adressen blobs posten
 * voor welke rollup (blobs_submitters.sql, ~125 adressen). Blobscan labelt
 * lang niet alles; zonder deze lijst komt elke onbekende batcher van een al
 * lang draaiende rollup binnen als "naamloze rollup".
 *
 * Licentie: Spellbook valt onder BSL 1.1. We kopiëren de code niet en slaan
 * de lijst niet op; we lezen alleen de adresfeiten bij elke run, met bron.
 * Faalt het ophalen, dan gaan we door zonder lijst (liever een alert te veel).
 */

const SPELLBOOK_BLOBS = process.env.SPELLBOOK_BLOBS_URL ||
  'https://raw.githubusercontent.com/duneanalytics/spellbook/main/dbt_subprojects/hourly_spellbook/models/_sector/blobs/ethereum/blobs_submitters.sql';

/** (0xadres, 'Entiteit', ...) uit de SQL-values-lijst. */
export function parseSpellbookValues(sql) {
  const out = new Map();
  const re = /\(\s*(0x[0-9a-fA-F]{40})\s*,\s*'([^']*)'/g;
  for (const m of String(sql || '').matchAll(re)) out.set(m[1].toLowerCase(), m[2]);
  return out;
}

let cache = null;
export async function knownBlobSubmitters() {
  if (cache) return cache;
  try {
    const { text } = await getText(SPELLBOOK_BLOBS, { timeout: 15000, maxBytes: 600000 });
    cache = parseSpellbookValues(text);
    console.log(`[labels] ${cache.size} bekende blob-afzenders uit Spellbook`);
  } catch (e) {
    console.warn(`[labels] Spellbook niet bereikbaar (${e.message}); verder zonder lijst`);
    cache = new Map();
  }
  return cache;
}
