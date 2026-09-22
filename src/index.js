#!/usr/bin/env node
import { activeSources } from './sources/index.js';
import {
  loadState, saveSeen, saveNames, saveChains, saveHealth,
  loadPending, savePending, loadHeartbeat, saveHeartbeat,
} from './store.js';
import { notify, formatChain, summaryMessage, notifyError } from './notify.js';
import { buildDashboard } from './dashboard.js';
import { enrichChains } from './enrich.js';
import { scoreChain } from './score.js';
import { probePending, toPendingEntry, restorePending } from './probe.js';
import { nowIso, hourIso } from './util.js';

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE_BOOTSTRAP = argv.has('--bootstrap');

/** Deze fasen komen op de wachtlijst: er is een RPC, maar nog geen leven. */
const PRELAUNCH_KINDS = new Set(['proposal', 'upcoming']);

/** Hoe lang we zwijgen over een bron die al kapot is, zodat je niet 288x/dag gepingd wordt. */
const ERROR_SILENCE_MS = 6 * 60 * 60 * 1000;

const cfg = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  // Optioneel: aparte bestemming voor storingsmeldingen. Handig zodra de
  // alerts naar een publiek kanaal gaan en de foutmeldingen niet.
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || null,
  kinds: new Set(
    (process.env.WATCH_KINDS || 'mainnet,testnet,devnet,upcoming,proposal')
      .split(',').map((s) => s.trim()).filter(Boolean)
  ),
  crossListing: process.env.NOTIFY_CROSS_LISTING === 'true',
  disabled: (process.env.DISABLED_SOURCES || '').split(','),
  maxAlerts: Number(process.env.MAX_ALERTS_PER_RUN || 25),
  // Verrijking is best-effort en mag de run van 10 minuten nooit opeten.
  enrichLimit: Number(process.env.ENRICH_LIMIT || 12),
  enrichBudgetMs: Number(process.env.ENRICH_BUDGET_SECONDS || 150) * 1000,
  // Launch-detectie: RPC's van pre-launch chains pollen tot ze antwoorden.
  probe: process.env.PROBE_ENABLED !== 'false',
  probeLimit: Number(process.env.PROBE_LIMIT || 40),
  probeBudgetMs: Number(process.env.PROBE_BUDGET_SECONDS || 60) * 1000,
  probeTtlDays: Number(process.env.PROBE_TTL_DAYS || 120),
  // Waarschuwen als er een gat in de dekking zat. Drempel ruim boven de
  // afrondfout van een uur in de hartslag, zodat er geen vals alarm komt.
  staleHours: Number(process.env.STALE_ALERT_HOURS || 3),
};

async function main() {
  const sources = activeSources(cfg.disabled);
  const state = await loadState(sources.map((s) => s.id));
  const startedAt = nowIso();

  // Hartslag: stond de tool stil, dan is dat zelf het belangrijkste nieuws.
  // Zonder deze check lijkt een stilstand van uren op "geen nieuwe chains".
  const beat = await loadHeartbeat();
  const gapHours = beat?.lastRunAt
    ? (Date.now() - Date.parse(beat.lastRunAt)) / 3600000
    : null;

  console.log(`[chainwatch] ${startedAt} — ${sources.length} bronnen, dry-run=${DRY_RUN}`);

  const results = await Promise.allSettled(
    sources.map(async (s) => ({ source: s, records: await s.fetchAll() }))
  );

  const health = {};
  const perSource = []; // { src, allKeys, detected[], anomaly }
  // nameKeys die deze run NIEUW zijn, met de chain-keys die ze introduceerden.
  // Komt een alert niet aan, dan moet ook zijn nameKey weer weg: anders geldt de
  // chain bij de hervatting als "al bekend via andere bron" en verdwijnt hij stil.
  const newNames = new Map();

  // Momentopname vóór de detectie: alleen hiermee kun je zien of een project
  // al in een EERDERE fase bekend was. Zou je state.names zelf gebruiken, dan
  // telt een chain die deze run zowel als testnet als als mainnet binnenkomt
  // ten onrechte als promotie.
  const namesAtStart = new Set(state.names);

  for (const [i, res] of results.entries()) {
    const src = sources[i];
    const prevHealth = state.health[src.id] || {};

    if (res.status === 'rejected') {
      const error = String(res.reason?.message || res.reason).slice(0, 300);
      health[src.id] = {
        ok: false,
        error,
        failingSince: prevHealth.ok === false ? prevHealth.failingSince : startedAt,
        lastNotifiedAt: prevHealth.lastNotifiedAt,
      };
      console.error(`[${src.id}] FOUT: ${error}`);
      continue; // seen-set NIET aanraken: volgende run pakt het op
    }

    const { records } = res.value;
    const previous = state.seen[src.id];
    const isFirstRun = previous === null || FORCE_BOOTSTRAP;
    const seen = previous || new Set();
    const fresh = records.filter((r) => !seen.has(r.key));

    health[src.id] = { ok: true, wasFailing: prevHealth.ok === false };
    console.log(`[${src.id}] ${records.length} records, ${fresh.length} nieuw${isFirstRun ? ' (bootstrap)' : ''}`);

    const entry = { src, allKeys: records.map((r) => r.key), detected: [], anomaly: false };

    if (isFirstRun) {
      for (const r of records) state.names.add(r.nameKey);
      perSource.push(entry);
      continue;
    }

    // Anomalie is PER BRON: een bron die van formaat verandert mag geen echte
    // mainnet-alert van een gezonde bron degraderen tot een regel in een lijstje.
    if (fresh.length > cfg.maxAlerts * 2) {
      entry.anomaly = true;
      console.warn(`[${src.id}] ANOMALIE: ${fresh.length} nieuwe keys — waarschijnlijk formaatwijziging`);
    }

    // Sommige bronnen halen pas details op voor wat nieuw is (scheelt API-calls).
    let enriched = fresh;
    if (typeof src.enrich === 'function' && fresh.length && !entry.anomaly) {
      try {
        enriched = await src.enrich(fresh);
        console.log(`[${src.id}] na verrijking: ${enriched.length} relevant`);
      } catch (e) {
        console.warn(`[${src.id}] verrijking mislukt (${e.message}), gebruik ruwe records`);
      }
    }

    for (const r of enriched) {
      const crossListing = state.names.has(r.nameKey);
      if (!crossListing) {
        if (!newNames.has(r.nameKey)) newNames.set(r.nameKey, new Set());
        newNames.get(r.nameKey).add(r.key);
      }
      state.names.add(r.nameKey);
      entry.detected.push({ ...r, crossListing, ...promotionOf(r, namesAtStart), detectedAt: nowIso() });
    }
    perSource.push(entry);
  }

  const allDetected = perSource.flatMap((e) => e.detected);

  // ---- Verrijking en scoring -------------------------------------------------
  // Eerst bepalen wat uberhaupt een alert wordt: alleen daarvoor loont het om
  // websites, RDAP en GitHub te bevragen.
  const alertableBySource = new Map();
  for (const entry of perSource) {
    alertableBySource.set(
      entry,
      entry.detected
        .filter((c) => cfg.kinds.has(c.kind))
        .filter((c) => cfg.crossListing || !c.crossListing)
    );
  }

  // Een bron in anomalie levert honderden records; die gaan als samenvatting de
  // deur uit, dus verrijken heeft daar geen zin.
  const enrichQueue = [...alertableBySource.entries()]
    .filter(([entry]) => !entry.anomaly)
    .flatMap(([, list]) => list)
    .sort((a, b) => rank(a) - rank(b)); // pre-launch en mainnet eerst in de wachtrij

  await enrichChains(enrichQueue, { limit: cfg.enrichLimit, budgetMs: cfg.enrichBudgetMs });

  for (const c of allDetected) {
    const { score, reasons } = scoreChain(c);
    c.score = score;
    c.reasons = reasons;
  }

  // ---- Berichtgroepen bouwen -------------------------------------------------
  const groups = [];
  let alertableCount = 0;

  for (const entry of perSource) {
    const alertable = (alertableBySource.get(entry) || []).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0) || rank(a) - rank(b)
    );
    alertableCount += alertable.length;
    if (alertable.length === 0) continue;

    if (entry.anomaly || alertable.length > cfg.maxAlerts) {
      const reason = entry.anomaly
        ? `bron ${entry.src.id} leverde ongewoon veel nieuwe records — mogelijk formaatwijziging`
        : `bron ${entry.src.id}`;
      groups.push({ text: summaryMessage(alertable, reason), keys: alertable.map((c) => c.key) });
    } else {
      for (const c of alertable) groups.push({ text: formatChain(c), keys: [c.key] });
    }
  }

  // ---- Launch-detectie op de wachtlijst --------------------------------------
  // Elke pre-launch detectie levert een RPC-URL op. Die antwoordt pas na
  // genesis, dus dit geeft het launchmoment op de minuut nauwkeurig — meestal
  // ruim voordat een register de chain als 'live' kent.
  const pendingBefore = await loadPending();
  // Chains die een andere bron intussen al als live meldde hoeven we niet meer
  // te pollen: dat bericht is dan al de deur uit.
  const stillPending = pendingBefore.filter((e) => !e.liveNameKey || !state.names.has(e.liveNameKey));
  let launched = [];
  let keepPending = stillPending;

  if (cfg.probe && stillPending.length) {
    const res = await probePending(stillPending, {
      limit: cfg.probeLimit,
      budgetMs: cfg.probeBudgetMs,
      ttlDays: cfg.probeTtlDays,
    });
    launched = res.launched;
    keepPending = res.keep;
  }

  // Launch-alerts gaan bewust buiten WATCH_KINDS om en bovenaan: dit is het
  // bericht waar de hele wachtlijst voor bestaat.
  groups.unshift(...launched.map((l) => ({ text: formatChain(l), keys: [l.key] })));

  console.log(`[chainwatch] ${allDetected.length} gedetecteerd, ${alertableCount} alertwaardig, ${launched.length} live gegaan`);

  const { delivered, failed, errors, sent } = await notify(groups, { ...cfg, dryRun: DRY_RUN });

  // ---- State wegschrijven ----------------------------------------------------
  // Keys waarvan de alert NIET aankwam blijven buiten de seen-set, zodat de
  // volgende run het opnieuw probeert. Zonder dit zou één Telegram-hik de
  // detectie permanent inslikken.
  if (!DRY_RUN) {
    for (const entry of perSource) {
      const seen = state.seen[entry.src.id] || new Set();
      for (const key of entry.allKeys) {
        if (!failed.has(key)) seen.add(key);
      }
      state.seen[entry.src.id] = seen;
      await saveSeen(entry.src.id, seen);
    }
    if (failed.size) {
      console.warn(`[chainwatch] ${failed.size} chain(s) niet afgeleverd, worden volgende run opnieuw geprobeerd`);
      // nameKey terugdraaien als élke chain die hem introduceerde is mislukt
      for (const [nk, keys] of newNames) {
        if ([...keys].every((k) => failed.has(k))) state.names.delete(nk);
      }
    }

    // Wachtlijst bijwerken. Een launch-alert die niet aankwam zet de chain
    // terug op de lijst, zodat de volgende run het opnieuw probeert.
    const newPending = [...keepPending];
    for (const l of launched) {
      if (failed.has(l.key)) newPending.push(restorePending(l));
    }
    for (const c of allDetected) {
      if (!PRELAUNCH_KINDS.has(c.kind) || failed.has(c.key)) continue;
      const entry = toPendingEntry(c);
      if (entry) newPending.push(entry);
    }
    // Op het uur afgerond: hoogstens 24 commits per dag in plaats van een
    // commit bij elke run.
    const stamp = hourIso();
    if (beat?.lastRunAt !== stamp) await saveHeartbeat({ lastRunAt: stamp });

    const saved = await savePending(newPending);
    console.log(`[chainwatch] wachtlijst: ${saved.length} pre-launch chain(s)`);

    await saveNames(state.names);
    const kept = [...launched, ...allDetected].filter((c) => !failed.has(c.key));
    const history = await saveChains([...kept, ...state.chains]);
    await saveHealth(health);
    await buildDashboard(history, { health });
  }

  // ---- Dekkingsgat melden ----------------------------------------------------
  if (Number.isFinite(gapHours) && gapHours > cfg.staleHours) {
    const uren = gapHours.toFixed(1).replace('.', ',');
    await notifyError(
      `De watcher heeft ${uren} uur stilgestaan (laatste run ${beat.lastRunAt}).\n` +
        `GitHub Actions knijpt cron-schedules af; een externe trigger op workflow_dispatch ` +
        `lost dat op. Zie het kopje "Echt elke 5 minuten draaien" in de README.`,
      { ...cfg, dryRun: DRY_RUN }
    );
  }

  // ---- Bronfouten melden, met stilteperiode ----------------------------------
  const toReport = [];
  for (const [id, h] of Object.entries(health)) {
    if (h.ok) {
      if (h.wasFailing) console.log(`[${id}] hersteld`);
      continue;
    }
    const last = h.lastNotifiedAt ? Date.parse(h.lastNotifiedAt) : 0;
    if (Date.now() - last > ERROR_SILENCE_MS) {
      toReport.push(`${id}: ${h.error}`);
      h.lastNotifiedAt = startedAt;
    }
  }
  if (toReport.length) {
    await notifyError(
      `${toReport.length} bron(nen) falen:\n${toReport.join('\n')}\n(volgende melding pas over 6 uur)`,
      { ...cfg, dryRun: DRY_RUN }
    );
    if (!DRY_RUN) await saveHealth(health);
  }

  if (errors.length) {
    // Bewust GEEN exit 1: de workflow moet de state kunnen committen. De
    // mislukte chains staan al buiten de seen-set en komen vanzelf terug.
    console.error(`[chainwatch] ${errors.length} verzendfout(en); wordt volgende run hervat`);
  }
  console.log(`[chainwatch] klaar — ${sent} bericht(en) verstuurd`);
}

/**
 * Kenden we dit project al in een eerdere levensfase?
 *
 * Een chain die je al als testnet of als aankondiging zag en nu mainnet gaat,
 * is iets heel anders dan een wildvreemde nieuwe chain: het is een project met
 * een geschiedenis dat nu echt begint. Dat verdient een eigen vermelding in
 * het bericht en een hogere prioriteit.
 */
function promotionOf(r, namesAtStart) {
  if (r.kind !== 'mainnet') return {};
  const slug = String(r.nameKey).split(':')[0];
  if (namesAtStart.has(`${slug}:test`)) return { promotedFrom: 'testnet', wasTrackedAs: 'testnet' };
  if (namesAtStart.has(`${slug}:pre`)) return { promotedFrom: 'pre-launch', wasTrackedAs: 'aangekondigd project' };
  return {};
}

/** Sorteervolgorde in de alertstroom: mainnets eerst, ruis achteraan. */
function rank(c) {
  const order = { mainnet: 0, testnet: 1, upcoming: 2, devnet: 3, proposal: 4 };
  return (order[c.kind] ?? 9) + (c.crossListing ? 10 : 0);
}

main().catch(async (e) => {
  console.error('[chainwatch] fatale fout:', e);
  await notifyError(`Run gecrasht: ${e.message}`, { ...cfg, dryRun: DRY_RUN });
  process.exit(1);
});
