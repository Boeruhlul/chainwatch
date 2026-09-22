import { sleep } from './http.js';
import { esc, clamp } from './util.js';
import { badgeFor } from './score.js';

const TG_LIMIT = 4096;
/** Marge onder de harde limiet, zodat HTML-entities er nooit overheen duwen. */
const SAFE_LEN = 3800;
const MAX_NAME = 110;

const KIND_LABEL = {
  mainnet: '🟢 NIEUWE MAINNET',
  testnet: '🧪 NIEUWE TESTNET',
  devnet: '🛠 NIEUWE DEVNET',
  upcoming: '🔭 NIEUW GETRACKT PROJECT',
  proposal: '📝 CHAIN ID AANGEVRAAGD (pre-launch)',
};

export function formatChain(c) {
  const badge = badgeFor(c.score ?? 0);
  const lines = [
    `${badge.icon} <b>${KIND_LABEL[c.kind] || 'NIEUW'}</b>\n<b>${esc(clamp(c.name, MAX_NAME))}</b>`,
  ];

  const facts = [];
  if (c.chainId != null) facts.push(`Chain ID: <code>${esc(c.chainId)}</code>`);
  if (c.ecosystem && c.ecosystem !== 'onbekend') facts.push(`Ecosysteem: ${esc(c.ecosystem)}`);
  if (c.nativeCurrency) facts.push(`Token: ${esc(c.nativeCurrency)}`);
  if (c.parent) facts.push(`L2 op: ${esc(c.parent)}`);
  if (typeof c.tvl === 'number' && c.tvl > 0) facts.push(`TVL: $${c.tvl.toLocaleString('nl-NL')}`);
  if (facts.length) lines.push(facts.join(' · '));

  if (c.description) lines.push(`<i>${esc(clamp(c.description, 220))}</i>`);
  if (c.wasTrackedAs) lines.push(`♻️ Eerder gezien als <i>${esc(c.wasTrackedAs)}</i> — nu live`);

  // Leeftijdssignalen: hieraan zie je of je echt vroeg bent.
  const age = [];
  if (typeof c.domain?.ageDays === 'number') age.push(`domein ${humanAge(c.domain.ageDays)}`);
  if (typeof c.github?.ageDays === 'number') age.push(`GitHub-org ${humanAge(c.github.ageDays)}`);
  if (age.length) lines.push(`⏳ ${esc(age.join(' · '))}`);

  // Socials: het deel waar je zelf verder mee kunt.
  const soc = c.socials || {};
  const links = [];
  if (c.website) links.push(`🌐 ${esc(clamp(c.website, 120))}`);
  if (soc.x) links.push(`𝕏 ${esc(soc.x)}`);
  if (soc.telegram) links.push(`✈️ ${esc(soc.telegram)}`);
  if (soc.discord) links.push(`💬 ${esc(soc.discord)}`);
  if (soc.github) links.push(`⚙️ ${esc(soc.github)}`);
  if (soc.docs) links.push(`📚 ${esc(clamp(soc.docs, 120))}`);
  if (links.length) lines.push(links.join('\n'));

  for (const f of (c.faucets || []).slice(0, 2)) lines.push(`💧 Faucet: ${esc(clamp(f, 200))}`);
  if (c.rpc?.length) {
    lines.push(`🔌 RPC: <code>${esc(clamp(c.rpc[0], 200))}</code>${c.rpc.length > 1 ? ` (+${c.rpc.length - 1})` : ''}`);
  }
  if (c.explorers?.length) lines.push(`🔍 Explorer: ${esc(clamp(c.explorers[0], 200))}`);

  lines.push(`🔗 ${esc(clamp(c.url, 300))}`);

  const why = (c.reasons || []).length ? ` · ${c.reasons.join(', ')}` : '';
  lines.push(`<i>bron: ${esc(c.source)} · prioriteit ${c.score ?? 0}/100${esc(why)}</i>`);
  return clamp(lines.join('\n'), SAFE_LEN);
}

/** Leeftijd in mensentaal; hoe verser, hoe preciezer. */
function humanAge(days) {
  if (days < 1) return 'vandaag geregistreerd';
  if (days < 45) return `${days} dagen oud`;
  if (days < 730) return `${Math.round(days / 30)} maanden oud`;
  return `${Math.round(days / 365)} jaar oud`;
}

/** Samenvatting voor als één bron ineens honderden records oplevert. */
export function summaryMessage(chains, reason = '') {
  const byKind = {};
  for (const c of chains) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  const head =
    `<b>🔔 ${chains.length} nieuwe netwerken gedetecteerd</b>${reason ? `\n<i>${esc(reason)}</i>` : ''}\n` +
    Object.entries(byKind).map(([k, n]) => `${KIND_LABEL[k] || k}: ${n}`).join('\n');

  // Vul regels tot we tegen de limiet aanlopen i.p.v. blind op 40 te cappen:
  // PR-titels kunnen lang zijn en zouden het bericht anders laten afketsen.
  const lines = [];
  let used = head.length + 2;
  let shown = 0;
  for (const c of chains) {
    const line = `${badgeFor(c.score ?? 0).icon} ${esc(clamp(c.name, 80))}${c.chainId != null ? ` (${esc(c.chainId)})` : ''} — ${esc(c.source)}`;
    if (used + line.length + 60 > SAFE_LEN) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const more = chains.length > shown ? `\n… en ${chains.length - shown} meer, zie dashboard` : '';
  return `${head}\n\n${lines.join('\n')}${more}`;
}

// Testhaak: laat de tests een lokale server gebruiken i.p.v. Telegram.
const TG_API = process.env.CHAINWATCH_TG_API || 'https://api.telegram.org';

async function tgSend(token, chatId, text) {
  if (text.length > TG_LIMIT) {
    throw new Error(`bericht te lang (${text.length} > ${TG_LIMIT})`);
  }
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const err = new Error(`Telegram ${res.status}: ${body.description || 'onbekende fout'}`);
    err.retryAfter = body.parameters?.retry_after;
    throw err;
  }
  return body;
}

/**
 * Verstuurt berichtgroepen en rapporteert PER GROEP of het gelukt is.
 * De caller gebruikt dat om alleen daadwerkelijk afgeleverde chains als 'gezien'
 * weg te schrijven; een mislukte alert wordt de volgende run opnieuw geprobeerd.
 */
export async function notify(groups, { token, chatId, dryRun }) {
  const delivered = new Set();
  const failed = new Set();
  const errors = [];
  if (groups.length === 0) return { delivered, failed, errors, sent: 0 };

  // Bepaal eerst WAT er verstuurd zou worden, zodat de console-fallback en de
  // echte verzending altijd identiek zijn.
  if (!token || !chatId) {
    if (!dryRun) console.warn('[notify] TELEGRAM_BOT_TOKEN/CHAT_ID ontbreken — alleen loggen');
    for (const g of groups) {
      console.log(`\n${g.text.replace(/<[^>]+>/g, '')}`);
      // Zonder kanaal is er niets afgeleverd. We markeren toch als delivered,
      // anders blijft een tokenloze opstelling eeuwig dezelfde chains loggen.
      for (const k of g.keys) delivered.add(k);
    }
    return { delivered, failed, errors, sent: 0 };
  }

  let sent = 0;
  for (const [i, g] of groups.entries()) {
    if (dryRun) {
      console.log(`\n--- [dry-run] bericht ${i + 1}/${groups.length} ---\n${g.text}`);
      for (const k of g.keys) delivered.add(k);
      sent++;
      continue;
    }
    try {
      await tgSend(token, chatId, g.text);
      for (const k of g.keys) delivered.add(k);
      sent++;
    } catch (e) {
      if (e.retryAfter) {
        // Telegram vroeg expliciet om te wachten; één nette herkansing.
        await sleep(Math.min(e.retryAfter * 1000 + 500, 30000));
        try {
          await tgSend(token, chatId, g.text);
          for (const k of g.keys) delivered.add(k);
          sent++;
          continue;
        } catch (e2) {
          e.message = e2.message;
        }
      }
      for (const k of g.keys) failed.add(k);
      errors.push(e.message);
      console.error(`[notify] ${e.message}`);
    }
    if (i < groups.length - 1) await sleep(1200);
  }
  return { delivered, failed, errors, sent };
}

export async function notifyError(text, { token, chatId, dryRun }) {
  if (dryRun || !token || !chatId) return console.warn(`[notify:error] ${text}`);
  try {
    await tgSend(token, chatId, clamp(`⚠️ <b>chainwatch</b>\n${esc(text)}`, SAFE_LEN));
  } catch (e) {
    console.error(`[notify:error] kon fout niet melden: ${e.message}`);
  }
}

export const limits = { TG_LIMIT, SAFE_LEN };
