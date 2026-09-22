import { getJson } from '../http.js';
import { probeRpc } from '../probe.js';
import { nameKey, uniq } from '../util.js';

/**
 * Nieuwe chain-hostnamen uit Certificate Transparency.
 *
 * Elk TLS-certificaat wordt publiek gelogd. Zet een team een sequencer of een
 * publieke RPC in de lucht, dan staat die hostnaam binnen minuten in die logs
 * — ook als de chain nog nergens is aangekondigd. Zo is Robinhood Chain
 * gevonden: `rpc.mainnet.chain.robinhood.com` antwoordde op eth_chainId
 * terwijl er nog geen woord over gezegd was.
 *
 * CT is rumoerig, maar die ruis lost zichzelf op: we vragen elke nieuwe
 * hostnaam gewoon om zijn chain ID. Wie niet antwoordt verdwijnt stil, wie wel
 * antwoordt IS een draaiende chain. Geen heuristiek nodig.
 */

// Smalle patronen. Kaal 'rpc.%' levert honderdduizenden treffers op en laat
// crt.sh omvallen; deze vormen zijn vrijwel uitsluitend blockchain-infra.
const DEFAULT_PATTERNS = [
  'rpc.mainnet.%',
  'rpc.testnet.%',
  'mainnet-rpc.%',
  'testnet-rpc.%',
  'rpc-mainnet.%',
  'sequencer.%',
  'rpc.chain.%',
];

// Hoeveel nieuwe hostnamen we per run aankloppen. Wat hier niet in past wordt
// door het raamwerk wél als gezien weggeschreven en dus nooit meer gepolld —
// vandaar ruim bemeten en parallel. Met deze smalle patronen zijn het er in
// rustige toestand een handvol per run.
const MAX_PROBE = 60;
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 5000;

function patterns() {
  const raw = process.env.CT_PATTERNS;
  if (!raw) return DEFAULT_PATTERNS;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_PATTERNS;
}

/** Hostnamen uit een crt.sh-antwoord, alleen die van de laatste dagen. */
export function hostsFromCrtSh(rows, { maxAgeDays = 7, now = Date.now() } = {}) {
  const cutoff = now - maxAgeDays * 86400000;
  const hosts = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = Date.parse(row?.entry_timestamp || row?.not_before || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;
    for (const raw of String(row?.name_value || '').split('\n')) {
      const host = raw.trim().toLowerCase();
      // Wildcard-certificaten geven geen bruikbaar adres om aan te kloppen.
      if (!host || host.startsWith('*') || !host.includes('.')) continue;
      hosts.add(host);
    }
  }
  return [...hosts];
}

export default {
  id: 'ct-hostnames',
  label: 'Certificate Transparency (stealth chains)',
  url: 'https://crt.sh',

  async fetchAll() {
    const found = new Set();
    const errors = [];

    for (const pattern of patterns()) {
      try {
        const rows = await getJson(
          `https://crt.sh/?q=${encodeURIComponent(pattern)}&output=json`,
          { timeout: 25000, retries: 1 }
        );
        for (const h of hostsFromCrtSh(rows)) found.add(h);
      } catch (e) {
        errors.push(`${pattern}: ${e.message}`);
      }
    }

    if (!found.size && errors.length) {
      throw new Error(`crt.sh onbereikbaar — ${errors.slice(0, 2).join('; ')}`);
    }
    if (errors.length) console.warn(`[ct-hostnames] ${errors.length} patroon/patronen mislukt`);

    return [...found].map((host) => ({
      key: `ct:${host}`,
      source: 'ct-hostnames',
      name: host,
      nameKey: nameKey(host, 'proposal'),
      kind: 'stealth',
      stealthKind: 'hostname',
      ecosystem: 'onbekend',
      chainId: null,
      rpc: [`https://${host}`],
      explorers: [],
      faucets: [],
      host,
      url: `https://${host}`,
    }));
  },

  /**
   * Alleen hostnamen die daadwerkelijk een chain bedienen worden een alert.
   * De rest telt wel als gezien, dus we kloppen nooit twee keer bij hetzelfde
   * adres aan.
   */
  async enrich(fresh) {
    const targets = fresh.slice(0, MAX_PROBE);
    const out = [];
    let i = 0;

    async function worker() {
      while (i < targets.length) {
        const rec = targets[i++];
        const hit = await probeRpc(`https://${rec.host}`, { timeoutMs: PROBE_TIMEOUT_MS })
          .catch(() => ({ live: false }));
        if (!hit.live) continue;
        const name =
          hit.chainId != null
            ? `Onaangekondigde chain ${hit.chainId}`
            : `Onaangekondigde chain op ${rec.host}`;
        out.push({
          ...rec,
          name,
          nameKey: nameKey(hit.chainId != null ? `stealth${hit.chainId}` : rec.host, 'mainnet'),
          chainId: hit.chainId,
          ecosystem: hit.flavor === 'cosmos' ? 'Cosmos' : 'EVM',
          block: hit.block,
          liveRpc: hit.rpc,
          website: `https://${rec.host.split('.').slice(-2).join('.')}`,
          rpc: uniq([`https://${rec.host}`]),
        });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker)
    );

    if (fresh.length > MAX_PROBE) {
      console.warn(`[ct-hostnames] ${fresh.length - MAX_PROBE} hostnamen niet gepolld deze run`);
    }
    console.log(`[ct-hostnames] ${targets.length} gepolld, ${out.length} antwoordde`);
    return out;
  },
};
