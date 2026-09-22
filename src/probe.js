import { nowIso, uniq, nameKey } from './util.js';

/**
 * Levensteken-check op chains die we als pre-launch gezien hebben.
 *
 * Het idee: een chain-ID-aanvraag of een L2BEAT-vermelding komt altijd mét een
 * RPC-URL. Die URL antwoordt pas zodra genesis geweest is. Elke run twee
 * goedkope calls erheen en je weet het launchmoment op de minuut nauwkeurig —
 * uren tot dagen voordat de chain ergens als "live" geregistreerd staat.
 *
 * Een RPC die antwoordt is per definitie geen ruis: daar draait iets.
 */

const TIMEOUT_MS = 8000;

/** Eén JSON-RPC call. Geen retries: dit is een levensteken, geen databron. */
async function rpcCall(url, method, params = []) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(body.error.message || 'rpc error');
    return body?.result;
  } finally {
    clearTimeout(timer);
  }
}

async function tendermintStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/status`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probeert één RPC-URL. Eerst EVM, dan Tendermint — in die volgorde omdat de
 * meeste pre-launch detecties EVM zijn en een POST naar een Tendermint-node
 * goedkoop faalt.
 */
export async function probeRpc(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { live: false };

  try {
    const hex = await rpcCall(url, 'eth_chainId');
    if (typeof hex === 'string' && /^0x[0-9a-f]+$/i.test(hex)) {
      let block = null;
      try {
        const b = await rpcCall(url, 'eth_blockNumber');
        if (typeof b === 'string') block = Number.parseInt(b, 16);
      } catch { /* chainId alleen is genoeg bewijs dat hij leeft */ }
      return { live: true, flavor: 'evm', chainId: Number.parseInt(hex, 16), block, rpc: url };
    }
  } catch { /* geen EVM-node; probeer Tendermint */ }

  try {
    const res = await tendermintStatus(url);
    const r = res?.result || res;
    const height = Number(r?.sync_info?.latest_block_height);
    if (Number.isFinite(height)) {
      return { live: true, flavor: 'cosmos', chainId: r?.node_info?.network || null, block: height, rpc: url };
    }
  } catch { /* niet bereikbaar */ }

  return { live: false };
}

/** Wat er van een detectie in de wachtlijst bewaard wordt. */
export function toPendingEntry(c) {
  const rpc = uniq((c.rpc || []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))).slice(0, 3);
  if (!rpc.length) return null; // zonder RPC valt er niets te pollen
  return {
    key: c.key,
    name: c.name,
    source: c.source,
    kind: c.kind,
    // Sleutel waaronder deze chain zou binnenkomen als een andere bron hem
    // live ziet. Zo voorkomen we twee "is live"-berichten voor hetzelfde ding.
    liveNameKey: nameKey(c.name, 'mainnet'),
    chainId: c.chainId ?? null,
    ecosystem: c.ecosystem || null,
    nativeCurrency: c.nativeCurrency || null,
    url: c.url,
    rpc,
    explorers: (c.explorers || []).slice(0, 2),
    website: c.website || null,
    socials: c.socials || null,
    domain: c.domain || null,
    addedAt: nowIso(),
    checks: 0,
  };
}

/**
 * Pollt de wachtlijst. Geeft terug wat er live bleek en wat er nog openstaat.
 * Faalt nooit hard: een onbereikbare RPC is de normale uitkomst.
 */
export async function probePending(pending, { limit = 40, budgetMs = 60000, ttlDays = 120, concurrency = 6 } = {}) {
  const launched = [];
  const keep = [];
  const expired = [];
  const now = Date.now();
  const deadline = now + budgetMs;

  // Oudste eerst gecheckt zou de nieuwste laten verhongeren; nieuwste eerst is
  // beter, want een chain die net aangevraagd is gaat het snelst live.
  const queue = [...pending].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));

  const toCheck = [];
  for (const e of queue) {
    const ageDays = (now - Date.parse(e.addedAt || 0)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > ttlDays) { expired.push(e); continue; }
    if (toCheck.length < limit) toCheck.push(e);
    else keep.push(e); // deze run niet aan de beurt
  }

  let i = 0;
  async function worker() {
    while (i < toCheck.length) {
      const e = toCheck[i++];
      if (Date.now() > deadline) { keep.push(e); continue; }
      e.checks = (e.checks || 0) + 1;
      e.lastCheckedAt = nowIso();

      let hit = null;
      for (const url of e.rpc) {
        const r = await probeRpc(url).catch(() => ({ live: false }));
        if (r.live) { hit = r; break; }
      }
      if (!hit) { keep.push(e); continue; }

      const waitedDays = Math.max(0, Math.round((Date.now() - Date.parse(e.addedAt || 0)) / 86400000));
      launched.push({
        ...e,
        key: `launch:${e.key}`,
        kind: 'launched',
        // Zodat de caller de wachtlijst-entry kan herstellen als de alert niet
        // aankomt en hij dus opnieuw geprobeerd moet worden.
        pendingKey: e.key,
        pendingKind: e.kind,
        chainId: hit.chainId ?? e.chainId,
        expectedChainId: e.chainId,
        chainIdMismatch:
          e.chainId != null && hit.chainId != null && String(e.chainId) !== String(hit.chainId),
        block: hit.block,
        flavor: hit.flavor,
        liveRpc: hit.rpc,
        waitedDays,
        detectedAt: nowIso(),
        // Een launch is altijd het interessantste bericht van de dag.
        score: 95,
        reasons: ['RPC antwoordt', `${waitedDays}d na detectie`],
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, worker));

  if (expired.length) {
    console.log(`[probe] ${expired.length} wachtlijst-item(s) verlopen na ${ttlDays} dagen`);
  }
  console.log(
    `[probe] ${toCheck.length} gepollt, ${launched.length} live, ${keep.length} blijft open`
  );
  return { launched, keep };
}

/** Draait een launch-record terug naar zijn wachtlijst-entry. */
export function restorePending(l) {
  const {
    key, kind, pendingKey, pendingKind, expectedChainId, chainIdMismatch,
    block, flavor, liveRpc, waitedDays, detectedAt, score, reasons, ...rest
  } = l;
  return { ...rest, key: pendingKey, kind: pendingKind, chainId: expectedChainId ?? null };
}
