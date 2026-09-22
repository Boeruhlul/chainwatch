#!/usr/bin/env node
/**
 * Eenmalige vulling van de wachtlijst.
 *
 * Waarom dit bestaat: de launch-detectie zet alleen NIEUWE pre-launch
 * detecties op de wachtlijst. Chains die al gedetecteerd waren voordat die
 * functie bestond — openstaande chain-ID-aanvragen bijvoorbeeld — staan in de
 * seen-set en worden dus nooit meer opnieuw gemeld. Zonder deze backfill
 * zouden juist die chains hun launch missen.
 *
 * Draaien: npm run backfill
 * Verstuurt geen alerts en raakt de seen-set niet aan.
 */
import { activeSources } from './sources/index.js';
import { loadPending, savePending } from './store.js';
import { toPendingEntry } from './probe.js';

const PRELAUNCH_KINDS = new Set(['proposal', 'upcoming']);

const disabled = (process.env.DISABLED_SOURCES || '').split(',');
const sources = activeSources(disabled);

console.log(`[backfill] ${sources.length} bronnen ophalen`);

const existing = await loadPending();
const known = new Set(existing.map((e) => e.key));
const toAdd = [];

for (const src of sources) {
  let records;
  try {
    records = await src.fetchAll();
  } catch (e) {
    console.warn(`[backfill] ${src.id} overslaan: ${e.message}`);
    continue;
  }

  let pre = records.filter((r) => PRELAUNCH_KINDS.has(r.kind) && !known.has(r.key));
  if (!pre.length) {
    console.log(`[backfill] ${src.id}: niets pre-launch`);
    continue;
  }

  // De enrich-hook is wat de RPC-URL boven water haalt; zonder die call heeft
  // een PR-record niets om te pollen.
  if (typeof src.enrich === 'function') {
    try {
      pre = await src.enrich(pre);
    } catch (e) {
      console.warn(`[backfill] ${src.id} verrijking mislukt (${e.message})`);
    }
  }

  let added = 0;
  for (const r of pre) {
    const entry = toPendingEntry(r);
    if (!entry || known.has(entry.key)) continue;
    known.add(entry.key);
    toAdd.push(entry);
    added++;
  }
  console.log(`[backfill] ${src.id}: ${pre.length} pre-launch, ${added} met bruikbare RPC`);
}

const saved = await savePending([...existing, ...toAdd]);
console.log(`[backfill] wachtlijst: ${existing.length} -> ${saved.length} (${toAdd.length} toegevoegd)`);
