import { esc, clamp } from './util.js';
import { STAGES, stageLabel, isIntensive } from './dossiers.js';
import { explorerLink } from './ecosystem.js';

/**
 * Berichten die uit de dossierlaag komen: koppelingen, opwaarderingen,
 * ecosysteemvondsten, onderzoeksresultaten en het dagoverzicht.
 *
 * Opzet volgt de dossierkaart: wat is het, hoe zeker, wat is er gevonden,
 * welke infrastructuur staat er al, wat komt er nu, en de bewijslinks.
 * Feiten (uit bronnen) en hypothesen (uit onderzoek) staan altijd apart.
 */

const SAFE_LEN = 3800;
const CONF_LABEL = {
  A: 'A — bevestigd nieuw netwerk',
  B: 'B — sterke aanwijzing',
  C: 'C — interessante hypothese',
  D: 'D — zwakke lead',
};
export const confLabel = (c) => CONF_LABEL[c] || c || '?';

const NEXT_BY_STAGE = {
  lead: 'repo of registratie, chain ID, eerste RPC',
  aangekondigd: 'RPC die antwoordt (genesis), explorer, faucet',
  devnet: 'publiek testnet, chain ID voor mainnet',
  testnet: 'mainnet-chain-ID, eerste DEX of launchpad, bridge',
  draait: 'officiële naam/aankondiging, eerste DEX of launchpad',
  mainnet: 'liquiditeit en launchpads in de eerste 14 dagen',
};

const fmtDay = (d) => {
  if (!d) return '?';
  const t = new Date(`${d}T12:00:00Z`);
  return t.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/** De dossierkaart, gedeeld door alle gebeurtenissen. */
export function dossierCard(d, { head, extra = [] } = {}) {
  const L = [];
  L.push(`<b>${esc(head)}</b>`);
  const alias = (d.aliases || []).filter((a) => a.toLowerCase() !== String(d.name).toLowerCase()).slice(0, 4);
  L.push(`<b>Naam:</b> ${esc(d.name)}${alias.length ? ` <i>(ook: ${esc(alias.join(', '))})</i>` : ''}`);
  const type = [d.architecture, d.org ? `org: ${d.org}` : null].filter(Boolean).join(' · ');
  if (type) L.push(`<b>Type:</b> ${esc(clamp(type, 140))}`);
  L.push(`<b>Status:</b> ${esc(stageLabel(d.stage))}`);
  L.push(`<b>Confidence:</b> ${esc(confLabel(d.confidence))}`);
  if (d.reasons?.length) L.push(`<i>${esc(clamp(d.reasons.join('; '), 260))}</i>`);
  L.push(`<b>Eerste detectie:</b> ${fmtDay(d.firstSeen)}${d.chainIds?.length ? ` · chain ID ${esc(d.chainIds.slice(0, 3).join(', '))}` : ''}`);

  for (const x of extra) L.push(x);

  const ev = (d.evidence || []).slice(-6).reverse();
  if (ev.length) {
    L.push('\n<b>Wat is ontdekt?</b>');
    for (const e of ev) L.push(`• ${fmtDay(e.date)} — ${esc(clamp(e.what, 110))}${e.url ? `\n  ${esc(clamp(e.url, 160))}` : ''}`);
  }

  const eco = d.eco || {};
  const rEco = d.research?.ecosystem || {};
  const dex = eco.dex?.length ? `gevonden (${eco.dex.length})` : rEco.dex || 'onbekend';
  const pad = eco.launchpad?.length ? `kandidaat (${eco.launchpad.length})` : rEco.launchpad || 'onbekend';
  L.push('\n<b>Vroege infrastructuur:</b>');
  L.push(`DEX: ${esc(dex)} · Launchpad: ${esc(pad)}`);
  L.push(`Explorer: ${d.explorer ? esc(clamp(d.explorer, 120)) : 'onbekend'} · Bridge: ${esc(rEco.bridge || 'onbekend')}`);
  if (d.liveRpc) L.push(`✅ RPC antwoordt: <code>${esc(clamp(d.liveRpc, 160))}</code>`);
  else if (d.rpc?.length) L.push(`🔌 RPC (niet bevestigd): <code>${esc(clamp(d.rpc[0], 160))}</code>`);
  if (d.website) L.push(`🌐 ${esc(clamp(d.website, 120))}`);

  const next = d.research?.nextSignals?.length ? d.research.nextSignals.join(', ') : NEXT_BY_STAGE[d.stage];
  if (next) L.push(`\n<b>Volgende signalen:</b> ${esc(clamp(next, 240))}`);
  if (d.research?.expectedLaunch) L.push(`<b>Lancering:</b> ${esc(d.research.expectedLaunch)}`);

  const facts = d.research?.facts || [];
  const hyp = d.research?.hypotheses || [];
  if (facts.length || hyp.length) {
    L.push('\n<b>Onderzoeksconclusie</b>');
    for (const f of facts.slice(0, 3)) L.push(`✔︎ ${esc(clamp(f.claim, 160))}${f.url ? ` — ${esc(clamp(f.url, 140))}` : ''}`);
    for (const h of hyp.slice(0, 2)) L.push(`❓ <i>${esc(clamp(h, 160))}</i>`);
  }
  L.push(`<i>dossier: ${esc(d.id)}</i>`);
  return clamp(L.join('\n'), SAFE_LEN);
}

/** Directe melding voor een dossiergebeurtenis. */
export function formatEvent(db, ev) {
  const d = db.dossiers[ev.id];
  if (!d) return null;
  if (ev.type === 'link') {
    return dossierCard(d, {
      head: '🔗 CODENAAM / PROJECT GEKOPPELD',
      extra: [
        `<b>Gekoppeld:</b> ${esc(ev.linked)} → ${esc(d.name)}`,
        `<i>via ${esc((ev.via || []).join(', ') || 'gedeelde sleutel')} · aanleiding: ${esc(ev.trigger?.source || '?')}</i>`,
      ],
    });
  }
  if (ev.type === 'upgrade') {
    return dossierCard(d, {
      head: `🧩 VERBAND GELEGD — van ${ev.from} naar ${ev.to}`,
      extra: [`<i>nieuw bewijs: ${esc(ev.trigger?.source || '?')}${ev.trigger?.url ? ` — ${esc(clamp(ev.trigger.url, 160))}` : ''}</i>`],
    });
  }
  if (ev.type === 'eco') {
    const lines = [];
    for (const x of (ev.dex || []).slice(0, 3)) {
      lines.push(`🏪 DEX (${esc(x.type)}): <code>${esc(x.addr)}</code> · ${x.pools} pool(s) in venster${explorerLink(d, x.addr) ? `\n  ${esc(explorerLink(d, x.addr))}` : ''}`);
    }
    for (const x of (ev.launchpad || []).slice(0, 3)) {
      lines.push(`🚀 Launchpad-kandidaat: <code>${esc(x.addr)}</code> · ontving de beginvoorraad van ${x.tokens} nieuwe tokens${explorerLink(d, x.addr) ? `\n  ${esc(explorerLink(d, x.addr))}` : ''}`);
    }
    const act = [];
    if (typeof ev.latest === 'number') act.push(`blok ${ev.latest.toLocaleString('nl-NL')}`);
    if (typeof ev.span === 'number') act.push(`laatste ${ev.span.toLocaleString('nl-NL')} blokken`);
    if (typeof ev.newTokens === 'number') act.push(`${ev.newTokens} nieuwe token(s)`);
    if (typeof ev.pools === 'number') act.push(`${ev.pools} nieuwe pool(s)`);
    if (act.length) lines.push(`⏱ ${esc(act.join(' · '))}`);
    lines.push('<i>Launchpad = contract dat de beginvoorraad van meerdere verse tokens ontvangt. Zoek het adres op in de explorer om de site te vinden; controleer altijd zelf voor je iets doet.</i>');
    const what = [ev.dex?.length ? 'DEX' : null, ev.launchpad?.length ? 'LAUNCHPAD' : null].filter(Boolean).join(' + ');
    return dossierCard(d, { head: `🏁 EERSTE ${what} OP ${String(d.name).toUpperCase()}`, extra: lines });
  }
  return null;
}

/** Eén bericht (of een paar) met alle onderzoekskandidaten van deze run. */
export function researchMessages(db, records) {
  if (!records.length) return [];
  const order = { A: 0, B: 1, C: 2, D: 3 };
  const rows = records
    .map((r) => ({ r, d: db.dossiers[r.dossierId] }))
    .filter((x) => x.d)
    .sort((a, b) => (order[a.r.research.confidence] ?? 9) - (order[b.r.research.confidence] ?? 9));
  const file = records[0].research?.file || '';
  const head = `🔎 <b>DEEP RESEARCH — ${rows.length} kandidaten</b>\n<i>${esc(file)} · feiten en hypothesen staan per dossier apart</i>`;
  const msgs = [];
  let cur = head;
  for (const { r, d } of rows) {
    const rs = r.research;
    const known = (d.evidence || []).some((e) => e.source !== 'research');
    const line =
      `\n\n<b>${esc(rs.confidence)} · ${esc(r.name)}</b> — ${esc(stageLabel(d.stage))}${rs.architecture ? ` · ${esc(rs.architecture)}` : ''}` +
      `${known ? ' · <i>ook uit eigen bronnen bekend</i>' : ''}` +
      `${rs.why ? `\n${esc(clamp(rs.why, 220))}` : ''}` +
      `${rs.expectedLaunch ? `\n📅 ${esc(rs.expectedLaunch)}` : ''}` +
      `${r.url ? `\n🔗 ${esc(clamp(r.url, 160))}` : ''}`;
    if (cur.length + line.length > SAFE_LEN) {
      msgs.push(cur);
      cur = `🔎 <b>DEEP RESEARCH (vervolg)</b>`;
    }
    cur += line;
  }
  msgs.push(cur);
  return msgs;
}

// ---------------------------------------------------------------------------
// Dagoverzicht
// ---------------------------------------------------------------------------

/** Datum en uur in Amsterdam, ongeacht waar de runner staat. */
export function amsterdamNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: parts.weekday };
}

export function digestDue(db, { hour = 8, now = new Date() } = {}) {
  const a = amsterdamNow(now);
  return a.hour >= hour && db.digest?.lastSent !== a.date ? a : null;
}

/**
 * Het dagoverzicht. Bevat alles wat geen directe melding waard was, en zegt
 * het eerlijk als er niets gebeurde.
 */
export function buildDigest(db, { since, today, weekly = false, health = {} } = {}) {
  const all = Object.values(db.dossiers).filter((d) => !d.blocked);
  const isNew = (d) => (d.firstSeen || '') >= since;
  const fresh = all.filter(isNew);
  const strong = fresh.filter((d) => ['A', 'B'].includes(d.confidence) && d.stage !== 'lead');
  const weak = fresh.filter((d) => !strong.includes(d));
  const moved = all.filter((d) => !isNew(d) && (d.stageHistory || []).some((s) => s.date >= since && s !== d.stageHistory[0]));
  const ecoNew = all.filter((d) => [...(d.eco?.dex || []), ...(d.eco?.launchpad || [])].some((x) => x.date >= since));
  const intensive = all.filter((d) => isIntensive(d, today));
  const order = { A: 0, B: 1, C: 2, D: 3 };
  const byConf = (a, b) => (order[a.confidence] ?? 9) - (order[b.confidence] ?? 9) || STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage);

  const L = [`📊 <b>chainwatch — dagoverzicht ${fmtDay(today)}</b>`, `<i>sinds ${fmtDay(since)}</i>`];
  const line = (d) => `• <b>${esc(d.confidence)}</b> ${esc(clamp(d.name, 50))} — ${esc(stageLabel(d.stage))}${d.chainIds?.length ? ` (${esc(d.chainIds[0])})` : ''}`;

  if (!fresh.length && !moved.length && !ecoNew.length) {
    L.push('\nGeen nieuwe ontdekkingen of statuswijzigingen. De bronnen draaien; er is gewoon niets gebeurd.');
  }
  if (strong.length) {
    L.push(`\n🆕 <b>Nieuwe netwerken (A/B): ${strong.length}</b>`);
    for (const d of strong.sort(byConf).slice(0, 12)) L.push(line(d));
    if (strong.length > 12) L.push(`… en ${strong.length - 12} meer`);
  }
  if (moved.length) {
    L.push(`\n⬆️ <b>Dichter bij lancering: ${moved.length}</b>`);
    for (const d of moved.sort(byConf).slice(0, 10)) {
      const h = (d.stageHistory || []).filter((s) => s.date >= since).map((s) => stageLabel(s.stage));
      L.push(`• ${esc(clamp(d.name, 50))} → ${esc(h.join(' → '))}`);
    }
  }
  if (ecoNew.length) {
    L.push(`\n🏪 <b>Nieuwe DEX/launchpad: ${ecoNew.length}</b>`);
    for (const d of ecoNew.slice(0, 8)) L.push(`• ${esc(clamp(d.name, 50))} — ${(d.eco?.dex || []).length} DEX, ${(d.eco?.launchpad || []).length} launchpad`);
  }
  if (weak.length) {
    const leads = weak.sort(byConf);
    L.push(`\n🧪 <b>Onbevestigde signalen (C/D en losse aanwijzingen): ${weak.length}</b>`);
    for (const d of leads.slice(0, 10)) {
      const src = (d.evidence || [])[0]?.source || '?';
      L.push(`• ${esc(d.confidence)} ${esc(clamp(d.name, 50))} <i>(${esc(src)})</i>`);
    }
    if (leads.length > 10) L.push(`… en ${leads.length - 10} meer op het dashboard`);
  }

  const down = Object.entries(health).filter(([, h]) => h && h.ok === false).map(([id]) => id);
  L.push(`\n👀 Intensief gevolgd: ${intensive.length} · dossiers totaal: ${all.length}${down.length ? ` · ⚠️ bron(nen) in storing: ${esc(down.join(', '))}` : ''}`);

  if (weekly) {
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    for (const d of all) counts[d.confidence] = (counts[d.confidence] || 0) + 1;
    const stale = all
      .filter((d) => ['C', 'D'].includes(d.confidence) && d.lastActivity && (Date.parse(today) - Date.parse(d.lastActivity)) / 86400000 > 30)
      .sort(byConf);
    L.push(`\n📅 <b>Week</b> — A ${counts.A} · B ${counts.B} · C ${counts.C} · D ${counts.D}`);
    L.push(`Stille C/D-leads (>30 dagen geen nieuw bewijs, niet verwijderd): ${stale.length}`);
    for (const d of stale.slice(0, 6)) L.push(`• ${esc(clamp(d.name, 50))} — laatst ${fmtDay(d.lastActivity)}`);
  }
  return clamp(L.join('\n'), SAFE_LEN);
}
