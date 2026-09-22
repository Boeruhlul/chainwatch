import { getJson, sleep } from '../http.js';
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

// crt.sh is een gratis dienst die geregeld omvalt: 502's, time-outs en zelfs
// 404's op een query die vijf minuten eerder nog werkte. Patronen met de
// wildcard achteraan zijn daar ook nog eens de dure soort. Daarom vragen we
// per run maar een paar patronen, roulerend, binnen een vast tijdsbudget.
//
// Er gaat niets verloren als een patroon een run mist: crt.sh geeft bij elke
// query de hele historie terug, dus de volgende geslaagde query haalt het in.
// Een storing kost alleen vertraging — vandaar ook de lange alarmdrempel.
const SLOT_MS = 5 * 60 * 1000;
const PER_RUN = () => Math.max(1, Number(process.env.CT_PATTERNS_PER_RUN || 2));
const BUDGET_MS = () => Number(process.env.CT_BUDGET_SECONDS || 60) * 1000;
const BASE_URL = () => (process.env.CT_BASE_URL || 'https://crt.sh').replace(/\/$/, '');
const QUERY_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 3;

function patterns() {
  const raw = process.env.CT_PATTERNS;
  if (!raw) return DEFAULT_PATTERNS;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_PATTERNS;
}

/**
 * Welke patronen deze run aan de beurt zijn. Staatloos: afgeleid van het
 * tijdvak van 5 minuten, zodat er niets in de state hoeft (en dus niets te
 * committen valt). Bij een run per 5 minuten komt elk patroon binnen
 * ceil(patronen / perRun) runs langs.
 */
export function pickPatterns(all, perRun, now = Date.now()) {
  if (perRun >= all.length) return [...all];
  const slot = Math.floor(now / SLOT_MS);
  const start = (slot * perRun) % all.length;
  return Array.from({ length: perRun }, (_, k) => all[(start + k) % all.length]);
}

/**
 * Eén crt.sh-query met eigen retries. Anders dan getJson behandelen we hier
 * ook 404 en kapotte JSON als tijdelijk: bij crt.sh betekent dat overbelasting,
 * geen ontbrekende pagina (een lege uitslag is gewoon []).
 */
async function queryCrtSh(pattern, deadline) {
  const url = `${BASE_URL()}/?q=${encodeURIComponent(pattern)}&output=json`;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      return await getJson(url, { timeout: Math.min(QUERY_TIMEOUT_MS, left), retries: 0 });
    } catch (e) {
      lastErr = e;
      const s = e.status;
      const transient = s === undefined || s === 404 || s === 429 || s >= 500;
      if (!transient) break;
      const pause = Math.min(1500 * 2 ** attempt, deadline - Date.now() - 2000);
      if (pause > 0) await sleep(pause);
    }
  }
  throw lastErr || new Error('tijdsbudget op');
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

  // Pas na zoveel uur zonder één geslaagde query is het een melding waard.
  // Losse storingen van crt.sh zijn ruis: er gaat niets verloren (zie boven).
  alertAfterHours: Number(process.env.CT_ALERT_AFTER_HOURS || 12),

  async fetchAll() {
    const found = new Set();
    const errors = [];
    const chosen = pickPatterns(patterns(), PER_RUN());
    const deadline = Date.now() + BUDGET_MS();
    let ok = 0;

    for (const pattern of chosen) {
      try {
        const rows = await queryCrtSh(pattern, deadline);
        ok++;
        for (const h of hostsFromCrtSh(rows)) found.add(h);
      } catch (e) {
        errors.push(`${pattern}: ${e.message}`);
      }
    }

    // Alleen falen als GEEN enkel patroon antwoordde. Vroeger was de regel
    // "niets gevonden én iets mislukt", maar in rustige tijden levert een
    // geslaagde query terecht nul verse hostnamen op — dan werd elke losse
    // 502 een bronfout.
    if (!ok && errors.length) {
      throw new Error(`crt.sh onbereikbaar — ${errors.slice(0, 2).join('; ')}`);
    }
    if (errors.length) console.warn(`[ct-hostnames] ${errors.length} van ${chosen.length} patronen mislukt: ${errors.join('; ')}`);
    console.log(`[ct-hostnames] patronen deze run: ${chosen.join(', ')}`);

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
