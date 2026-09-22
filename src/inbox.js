import { evmCall, hexToNum } from './evm.js';
import { nowIso, hourIso } from './util.js';

/**
 * Wacht tot een pas uitgerolde rollup zijn eerste batch schrijft.
 *
 * Een rollup-contract uitrollen kost een transactie; er daadwerkelijk een chain
 * op draaien is iets anders. Het verschil daartussen is precies de stille
 * periode waarin een team alles klaarzet zonder iets te zeggen.
 *
 * De sequencer-inbox houdt bij hoeveel batches er binnengekomen zijn. Gaat die
 * teller omhoog, dan produceert de chain — en dat lees je rechtstreeks van de
 * moederketen af, zonder ooit de RPC van het team nodig te hebben. Een chain
 * kan zijn RPC geheimhouden; zijn batches niet, want zonder die batches is hij
 * geen rollup.
 */

// batchCount() op ISequencerInbox. Selector uit keccak256("batchCount()").
const BATCH_COUNT = '0x06f13056';

async function batchCountOf(chain, inbox) {
  const res = await evmCall(chain, 'eth_call', [{ to: inbox, data: BATCH_COUNT }, 'latest'], {
    timeout: 12000,
  });
  const n = hexToNum(res);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wat we van een fabrieksvondst bewaren om te blijven volgen.
 *
 * De stand bij aanvang wordt vastgelegd: sommige inboxen beginnen niet op nul,
 * en dan zou "groter dan nul" meteen vals alarm geven. We willen de eerste
 * batch ná de uitrol, niet de uitrol zelf.
 */
export function toInboxEntry(c, baseline) {
  if (!c?.sequencerInbox || !c?.evmChain) return null;
  return {
    key: c.key,
    chain: c.evmChain,
    sequencerInbox: c.sequencerInbox,
    rollup: c.contract || null,
    chainId: c.chainId ?? null,
    name: c.name,
    deployer: c.deployer || null,
    url: c.url,
    explorer: c.explorer || null,
    baseline: Number.isFinite(baseline) ? baseline : 0,
    addedAt: nowIso(),
  };
}

/**
 * Pollt de gevolgde inboxen. Faalt nooit hard: een endpoint dat weigert
 * betekent gewoon dat we het volgende run opnieuw proberen.
 */
export async function watchInboxes(entries, { limit = 40, budgetMs = 45000, ttlDays = 180, concurrency = 4 } = {}) {
  const produced = [];
  const keep = [];
  const expired = [];
  const now = Date.now();
  const deadline = now + budgetMs;

  // Nieuwste eerst: een net uitgerolde rollup gaat het snelst produceren.
  const queue = [...entries].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const toCheck = [];
  for (const e of queue) {
    const ageDays = (now - Date.parse(e.addedAt || 0)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > ttlDays) { expired.push(e); continue; }
    if (toCheck.length < limit) toCheck.push(e);
    else keep.push(e);
  }

  let i = 0;
  async function worker() {
    while (i < toCheck.length) {
      const e = toCheck[i++];
      if (Date.now() > deadline) { keep.push(e); continue; }
      // Op het uur afgerond, anders verandert het bestand bij elke run.
      e.lastCheckedAt = hourIso();

      let count = null;
      try {
        count = await batchCountOf(e.chain, e.sequencerInbox);
      } catch {
        keep.push(e); // onbereikbaar is geen antwoord; volgende run opnieuw
        continue;
      }
      if (!Number.isFinite(count) || count <= (e.baseline || 0)) { keep.push(e); continue; }

      const waitedDays = Math.max(0, Math.round((Date.now() - Date.parse(e.addedAt || 0)) / 86400000));
      produced.push({
        ...e,
        key: `batch:${e.key}`,
        pendingKey: e.key,
        kind: 'launched',
        liveVia: 'batch',
        batches: count,
        waitedDays,
        detectedAt: nowIso(),
        score: 92,
        reasons: ['eerste batch op de moederketen', `${waitedDays}d na uitrol`],
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, worker));

  if (expired.length) console.log(`[inbox] ${expired.length} gevolgde inbox(en) verlopen na ${ttlDays} dagen`);
  console.log(`[inbox] ${toCheck.length} gepollt, ${produced.length} begon te produceren, ${keep.length} blijft open`);
  return { produced, keep };
}

/** Draait een productie-melding terug naar zijn volglijst-item. */
export function restoreInbox(p) {
  const { key, pendingKey, kind, liveVia, batches, waitedDays, detectedAt, score, reasons, ...rest } = p;
  return { ...rest, key: pendingKey };
}

export const _test = { BATCH_COUNT, batchCountOf };
