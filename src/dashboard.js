import fs from 'node:fs/promises';
import { esc } from './util.js';

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/**
 * Maakt JSON veilig om binnen een <script>-blok te zetten.
 * - '<' wordt geescaped zodat een chain-naam met een sluitende script-tag
 *   het blok niet voortijdig afbreekt (XSS via PR-titels en chain-namen).
 * - U+2028 en U+2029 zijn regeleindes in oudere JS-parsers.
 * Bewust geen enkele backslash-u-escapes in deze broncode: die overleven
 * kopieren tussen systemen niet altijd.
 */
function jsonForScript(rows) {
  return JSON.stringify(rows)
    .split('<').join('\\u003c')
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
}

/**
 * Genereert een statische, self-contained pagina met de detectiegeschiedenis.
 * Bedoeld voor GitHub Pages (Settings -> Pages -> branch main, map /docs).
 */
export async function buildDashboard(chains, { health }) {
  const rows = chains.slice(0, 500);
  const counts = rows.reduce((acc, c) => ((acc[c.kind] = (acc[c.kind] || 0) + 1), acc), {});
  const sourceStatus = Object.entries(health || {})
    .map(([id, h]) => `<span class="pill ${h.ok ? 'ok' : 'bad'}">${esc(id)}${h.ok ? '' : ' ✕'}</span>`)
    .join('');
  // Bewust GEEN "laatste run"-tijdstempel: die verandert elke 5 minuten en zou
  // bij elke run een commit forceren, ook als er niets gedetecteerd is.
  const lastChange = rows[0]?.detectedAt || null;
  // Dossiers en radar worden NIET in de pagina gebakken maar in de browser
  // opgehaald uit de repo zelf. Zo verandert index.html niet bij elke
  // dossierwijziging (geen extra commits) en zie je altijd de laatste stand.
  const repo = process.env.GITHUB_REPOSITORY || 'Boeruhlul/chainwatch';
  const rawBase = process.env.CHAINWATCH_RAW_BASE || `https://raw.githubusercontent.com/${repo}/main/data`;

  const html = `<!doctype html>
<html lang="nl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>chainwatch</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1a1a18;--mut:#6b6b64;--line:#e4e4df;--card:#fff;
--main:#1a7f5a;--test:#8a5a00;--up:#2f5fa8;--dev:#6b4ea8;--prop:#8a8a80;--live:#d4183d}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f0efec;--mut:#9a9a92;--line:#2b2b28;--card:#1c1c1a;
--main:#4ec99a;--test:#e0a33a;--up:#7aa7e8;--dev:#b29ae8;--prop:#9a9a92;--live:#ff6b8a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:var(--mut);font-size:.875rem;margin-bottom:20px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:96px}
.stat b{display:block;font-size:1.35rem;letter-spacing:-.02em}
.stat span{color:var(--mut);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
button{font:inherit;font-size:.8125rem;padding:5px 12px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
input[type=search]{font:inherit;font-size:.8125rem;padding:5px 12px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--fg);min-width:160px;flex:1}
.list{display:flex;flex-direction:column;gap:8px}
.row{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);
border-radius:10px;padding:12px 14px}
.row[data-kind=mainnet]{border-left-color:var(--main)}
.row[data-kind=testnet]{border-left-color:var(--test)}
.row[data-kind=upcoming]{border-left-color:var(--up)}
.row[data-kind=devnet]{border-left-color:var(--dev)}
.row[data-kind=proposal]{border-left-color:var(--prop)}
.row[data-kind=launched]{border-left-color:var(--live)}
.row h2{font-size:.9375rem;margin:0 0 3px;font-weight:600}
.row h2 a{color:inherit;text-decoration:none}.row h2 a:hover{text-decoration:underline}
.meta{color:var(--mut);font-size:.8125rem;display:flex;flex-wrap:wrap;gap:4px 10px}
.k{font-size:.6875rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.k.mainnet{color:var(--main)}.k.testnet{color:var(--test)}.k.upcoming{color:var(--up)}
.k.devnet{color:var(--dev)}.k.proposal{color:var(--prop)}.k.launched{color:var(--live)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8125em;
background:color-mix(in srgb,var(--fg) 7%,transparent);padding:1px 5px;border-radius:4px}
.pill{display:inline-block;font-size:.6875rem;padding:2px 8px;border-radius:999px;margin-right:4px;
background:color-mix(in srgb,var(--main) 15%,transparent);color:var(--main)}
.pill.bad{background:color-mix(in srgb,#d4183d 15%,transparent);color:#d4183d}
.desc{color:var(--mut);font-size:.8125rem;margin:0 0 4px}
.soc{margin-top:6px}
.soc a{color:var(--up);text-decoration:none;font-size:.8125rem}
.soc a:hover{text-decoration:underline}
.score{display:inline-block;min-width:26px;text-align:center;font-size:.6875rem;font-weight:700;
padding:2px 6px;border-radius:6px;margin-right:6px;vertical-align:1px;
background:color-mix(in srgb,var(--mut) 18%,transparent);color:var(--mut)}
.score.hi{background:color-mix(in srgb,#d4183d 16%,transparent);color:#d4183d}
.score.mid{background:color-mix(in srgb,var(--test) 18%,transparent);color:var(--test)}
.empty{color:var(--mut);padding:32px;text-align:center}
nav.tabs{display:flex;gap:4px;margin:0 0 20px;border-bottom:1px solid var(--line);overflow-x:auto}
nav.tabs a{padding:8px 14px;color:var(--mut);text-decoration:none;font-size:.875rem;font-weight:600;
border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
nav.tabs a[aria-current=page]{color:var(--fg);border-bottom-color:var(--fg)}
section[hidden]{display:none}
.conf{display:inline-block;min-width:22px;text-align:center;font-size:.6875rem;font-weight:700;padding:2px 6px;
border-radius:6px;margin-right:6px;vertical-align:1px}
.conf.A{background:color-mix(in srgb,var(--main) 18%,transparent);color:var(--main)}
.conf.B{background:color-mix(in srgb,var(--up) 18%,transparent);color:var(--up)}
.conf.C{background:color-mix(in srgb,var(--test) 18%,transparent);color:var(--test)}
.conf.D{background:color-mix(in srgb,var(--mut) 18%,transparent);color:var(--mut)}
.warn{color:var(--live);font-size:.8125rem;font-weight:600;margin:2px 0 4px}
details{margin-top:6px;font-size:.8125rem}
details summary{cursor:pointer;color:var(--up)}
details ul{margin:6px 0 0;padding-left:18px;color:var(--mut)}
details li{margin:2px 0}
details a,.row a.x{color:var(--up);text-decoration:none}
.fact{color:var(--fg)}.hyp{color:var(--mut);font-style:italic}
.tag{display:inline-block;font-size:.6875rem;padding:1px 7px;border-radius:999px;border:1px solid var(--line);margin-right:4px}
.note{color:var(--mut);font-size:.8125rem;margin:-8px 0 16px}
footer{margin-top:32px;color:var(--mut);font-size:.75rem}
</style></head><body><div class="wrap">
<h1>chainwatch</h1>
<nav class="tabs">
<a href="#chains" data-tab="chains">Chains</a>
<a href="#dossiers" data-tab="dossiers">Dossiers</a>
<a href="#radar" data-tab="radar">Radar</a>
<a href="#airdrops" data-tab="airdrops">🪂 Airdrops</a>
</nav>
<section id="tab-chains">
<div class="sub">Laatste detectie: <span id="lastchange" data-ts="${esc(lastChange || '')}">—</span> · bronnen: ${sourceStatus}</div>
<div class="stats">
${['launched', 'mainnet', 'testnet', 'upcoming', 'devnet', 'proposal']
  .map((k) => `<div class="stat"><b>${counts[k] || 0}</b><span>${k}</span></div>`)
  .join('')}
</div>
<div class="filters">
<button data-f="all" aria-pressed="true">Alles</button>
<button data-f="hot" aria-pressed="false">🔥 Hoog</button>
<button data-f="launched" aria-pressed="false">🚀 Live gegaan</button>
<button data-f="mainnet" aria-pressed="false">Mainnet</button>
<button data-f="testnet" aria-pressed="false">Testnet</button>
<button data-f="upcoming" aria-pressed="false">Upcoming</button>
<button data-f="proposal" aria-pressed="false">Pre-launch</button>
<input type="search" id="q" placeholder="Zoek op naam of chain ID…">
</div>
<div class="list" id="list"></div>
</section>

<section id="tab-dossiers" hidden>
<p class="note">Eén dossier per project, met al het bewijs dat chainwatch verzamelde. A = draait aantoonbaar, B = meerdere onafhankelijke bronnen, C = één technisch signaal, D = alleen nieuws of hypothese.</p>
<div class="filters" id="dfilters">
<button data-c="all" aria-pressed="true">Alles</button>
<button data-c="A" aria-pressed="false">A</button>
<button data-c="B" aria-pressed="false">B</button>
<button data-c="C" aria-pressed="false">C</button>
<button data-c="D" aria-pressed="false">D</button>
<button data-c="eco" aria-pressed="false">🏪 DEX/launchpad</button>
<button data-c="pre" aria-pressed="false">Nog geen mainnet</button>
<button data-c="suspect" aria-pressed="false">⚠️ Verdacht</button>
<input type="search" id="dq" placeholder="Zoek op naam, alias, chain ID of domein…">
</div>
<div class="list" id="dlist"><div class="empty">Laden…</div></div>
</section>

<section id="tab-radar" hidden>
<p class="note">Wat er vóór lanceringen zichtbaar werd, laatste 14 dagen.</p>
<div class="filters" id="rfilters">
<button data-r="all" aria-pressed="true">Alles</button>
<button data-r="audit" aria-pressed="false">🔐 Audits</button>
<button data-r="contracten" aria-pressed="false">🧱 Contracten</button>
<button data-r="vacature" aria-pressed="false">💼 Vacatures</button>
<button data-r="techniek" aria-pressed="false">🧪 Techniek</button>
<button data-r="bounty" aria-pressed="false">🛡 Bounties</button>
<button data-r="sdk" aria-pressed="false">📦 SDK's</button>
<input type="search" id="rq" placeholder="Zoek…">
</div>
<div class="list" id="rlist"><div class="empty">Laden…</div></div>
</section>

<section id="tab-airdrops" hidden>
<p class="note">Projecten waar genoeg signalen samenkomen die in het verleden aan een airdrop voorafgingen: verse funding, nog geen mainnet, points of testnet, audit-contest, DEX/launchpad. Optelsom, geen garantie.</p>
<div class="list" id="alist"><div class="empty">Laden…</div></div>
</section>

<footer>Gegenereerd door chainwatch · ${rows.length} detecties bewaard</footer>
</div>
<script>
const DATA = ${jsonForScript(rows)};
const list = document.getElementById('list'), q = document.getElementById('q');
let filter = 'all';
const fmt = d => { try { return new Date(d).toLocaleString('nl-NL',{dateStyle:'medium',timeStyle:'short'}); } catch { return d; } };
const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(){
  const term = q.value.trim().toLowerCase();
  const rows = DATA.filter(c =>
    (filter === 'all' ? true : filter === 'hot' ? (c.score || 0) >= 62 : c.kind === filter) &&
    (!term || (c.name||'').toLowerCase().includes(term) || String(c.chainId||'').includes(term))
  );
  if (!rows.length) { list.innerHTML = '<div class="empty">Niets gevonden.</div>'; return; }
  list.innerHTML = rows.map(c => {
    const bits = [];
    if (c.chainId != null) bits.push('<code>' + escape(c.chainId) + '</code>');
    if (c.ecosystem && c.ecosystem !== 'onbekend') bits.push(escape(c.ecosystem));
    if (c.nativeCurrency) bits.push(escape(c.nativeCurrency));
    if (c.faucets && c.faucets.length) bits.push('<a href="' + escape(c.faucets[0]) + '">faucet</a>');
    if (c.domain && typeof c.domain.ageDays === 'number') bits.push('domein ' + c.domain.ageDays + 'd');
    if (typeof c.block === 'number') bits.push('blok ' + c.block);
    if (typeof c.waitedDays === 'number') bits.push(c.waitedDays + 'd na detectie');
    bits.push('bron: ' + escape(c.source));
    bits.push(fmt(c.detectedAt));
    const soc = c.socials || {};
    const links = [];
    if (c.website) links.push(['site', c.website]);
    if (soc.x) links.push(['X', soc.x]);
    if (soc.telegram) links.push(['Telegram', soc.telegram]);
    if (soc.discord) links.push(['Discord', soc.discord]);
    if (soc.github) links.push(['GitHub', soc.github]);
    if (soc.docs) links.push(['docs', soc.docs]);
    const socHtml = links.length
      ? '<div class="meta soc">' + links.map(l =>
          '<a href="' + escape(l[1]) + '" target="_blank" rel="noopener">' + escape(l[0]) + '</a>').join('') + '</div>'
      : '';
    const sc = typeof c.score === 'number' ? c.score : 0;
    const badge = sc >= 62 ? 'hi' : sc >= 38 ? 'mid' : 'lo';
    return '<div class="row" data-kind="' + escape(c.kind) + '" data-score="' + sc + '">' +
      '<h2><span class="score ' + badge + '" title="prioriteit">' + sc + '</span>' +
      '<a href="' + escape(c.url) + '" target="_blank" rel="noopener">' + escape(c.name) + '</a></h2>' +
      (c.description ? '<div class="desc">' + escape(c.description) + '</div>' : '') +
      '<div class="meta"><span class="k ' + escape(c.kind) + '">' + escape(c.kind) + '</span>' +
      bits.map(b => '<span>' + b + '</span>').join('') + '</div>' + socHtml + '</div>';
  }).join('');
}
document.querySelectorAll('button[data-f]').forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('button[data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
q.addEventListener('input', render);
// ---- Tabs ----------------------------------------------------------------
const RAW = ${JSON.stringify(rawBase)};
const tabs = ['chains','dossiers','radar','airdrops'];
let DOS = null, RAD = null;
async function load(name){
  try {
    const r = await fetch(RAW + '/' + name + '.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) { return { error: String(e.message || e) }; }
}
async function show(){
  const t = (location.hash || '#chains').slice(1);
  const tab = tabs.includes(t) ? t : 'chains';
  tabs.forEach(x => { document.getElementById('tab-' + x).hidden = x !== tab; });
  document.querySelectorAll('nav.tabs a').forEach(a => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  if ((tab === 'dossiers' || tab === 'airdrops') && !DOS) { DOS = await load('dossiers'); }
  if ((tab === 'radar' || tab === 'airdrops') && !RAD) { RAD = await load('radar'); }
  if (tab === 'dossiers') renderDos();
  if (tab === 'radar') renderRad();
  if (tab === 'airdrops') renderAir();
}
window.addEventListener('hashchange', show);
const day = d => { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('nl-NL',{day:'numeric',month:'short',year:'numeric'}); } catch { return d; } };
const link = (u, t) => u ? '<a class="x" href="' + escape(u) + '" target="_blank" rel="noopener">' + escape(t || u) + '</a>' : '';
const trimSlash = (u) => { let x = String(u || ''); while (x.endsWith('/')) x = x.slice(0, -1); return x; };
const STAGE = {lead:'losse aanwijzing',aangekondigd:'aangekondigd',devnet:'devnet',testnet:'testnet',draait:'draait',mainnet:'mainnet'};

// ---- Dossiers ------------------------------------------------------------
let dfilter = 'all';
const dq = document.getElementById('dq'), dlist = document.getElementById('dlist');
function renderDos(){
  if (!DOS || DOS.error) { dlist.innerHTML = '<div class="empty">Dossiers niet te laden' + (DOS && DOS.error ? ' (' + escape(DOS.error) + ')' : '') + '.</div>'; return; }
  const term = dq.value.trim().toLowerCase();
  const all = Object.values(DOS.dossiers || {});
  const rows = all.filter(d => {
    if (d.blocked) return false;
    if (dfilter === 'suspect' && !d.suspect) return false;
    if (['A','B','C','D'].includes(dfilter) && d.confidence !== dfilter) return false;
    if (dfilter === 'eco' && !(d.eco && ((d.eco.dex||[]).length || (d.eco.launchpad||[]).length))) return false;
    if (dfilter === 'pre' && d.stage === 'mainnet') return false;
    if (!term) return true;
    const hay = [d.name, d.id, ...(d.aliases||[]), ...(d.chainIds||[]), d.website, ...(d.keys||[])].join(' ').toLowerCase();
    return hay.includes(term);
  }).sort((a,b) => String(b.lastActivity||'').localeCompare(String(a.lastActivity||'')) || a.id.localeCompare(b.id));
  if (!rows.length) { dlist.innerHTML = '<div class="empty">Niets gevonden.</div>'; return; }
  const shown = rows.slice(0, 200);
  dlist.innerHTML = '<div class="note">' + rows.length + ' dossiers' + (rows.length > 200 ? ', eerste 200 getoond' : '') + '</div>' + shown.map(d => {
    const meta = [];
    meta.push('<span class="k">' + escape(STAGE[d.stage] || d.stage || '?') + '</span>');
    if ((d.chainIds||[]).length) meta.push('<code>' + escape(d.chainIds.slice(0,3).join(', ')) + '</code>');
    if (d.architecture) meta.push(escape(d.architecture));
    meta.push('eerst ' + day(d.firstSeen));
    meta.push('laatst ' + day(d.lastActivity));
    const links = [];
    if (d.website) links.push(link(d.website, 'site'));
    if (d.explorer) links.push(link(d.explorer, 'explorer'));
    if (d.github) links.push(link(d.github, 'GitHub'));
    if (d.liveRpc) links.push('<span title="RPC antwoordt">✅ <code>' + escape(d.liveRpc) + '</code></span>');
    const eco = d.eco || {};
    const ecoBits = [];
    (eco.dex||[]).forEach(x => ecoBits.push('<li>🏪 DEX (' + escape(x.type) + '): ' + link(d.explorer ? trimSlash(d.explorer) + '/address/' + x.addr : null, x.addr) + (d.explorer ? '' : ' <code>' + escape(x.addr) + '</code>') + ' · ' + day(x.date) + '</li>'));
    (eco.launchpad||[]).forEach(x => ecoBits.push('<li>🚀 Launchpad-kandidaat: ' + link(d.explorer ? trimSlash(d.explorer) + '/address/' + x.addr : null, x.addr) + (d.explorer ? '' : ' <code>' + escape(x.addr) + '</code>') + ' · ' + day(x.date) + '</li>'));
    const rs = d.research || {};
    const facts = (rs.facts||[]).map(f => '<li class="fact">✔︎ ' + escape(f.claim) + (f.url ? ' — ' + link(f.url, 'bron') : '') + '</li>');
    const hyps = (rs.hypotheses||[]).map(h => '<li class="hyp">❓ ' + escape(h) + '</li>');
    const ev = (d.evidence||[]).slice().reverse().map(e => '<li>' + day(e.date) + ' — ' + escape(e.what) + (e.url ? ' ' + link(e.url, '↗') : '') + '</li>');
    const alias = (d.aliases||[]).filter(a => a.toLowerCase() !== String(d.name).toLowerCase()).slice(0,5);
    return '<div class="row" data-kind="' + (d.stage === 'mainnet' ? 'mainnet' : d.stage === 'testnet' ? 'testnet' : d.stage === 'draait' ? 'launched' : 'proposal') + '">' +
      '<h2><span class="conf ' + escape(d.confidence) + '">' + escape(d.confidence) + '</span>' + escape(d.name) +
      (alias.length ? ' <span class="desc">(' + escape(alias.join(', ')) + ')</span>' : '') + '</h2>' +
      (d.suspect ? '<div class="warn">⚠️ ' + (d.suspect.type === 'imitatie' ? 'Mogelijke imitatie van ' : 'Chain ID botst met ') + escape(d.suspect.other) + '</div>' : '') +
      (d.blocked ? '<div class="warn">🚫 Op je blocklist</div>' : '') +
      (rs.why ? '<div class="desc">' + escape(rs.why) + '</div>' : '') +
      '<div class="meta">' + meta.map(m => '<span>' + m + '</span>').join('') + '</div>' +
      ((d.reasons||[]).length ? '<div class="desc" style="margin-top:4px">' + escape(d.reasons.join(' · ')) + '</div>' : '') +
      (links.length ? '<div class="meta soc">' + links.join('') + '</div>' : '') +
      (ecoBits.length ? '<details open><summary>Vroege infrastructuur</summary><ul>' + ecoBits.join('') + '</ul></details>' : '') +
      (facts.length || hyps.length ? '<details><summary>Onderzoek: feiten en hypothesen</summary><ul>' + facts.join('') + hyps.join('') + (rs.expectedLaunch ? '<li>📅 ' + escape(rs.expectedLaunch) + '</li>' : '') + '</ul></details>' : '') +
      '<details><summary>Bewijs (' + ev.length + ')</summary><ul>' + ev.join('') + '</ul></details>' +
      '</div>';
  }).join('');
}
document.querySelectorAll('button[data-c]').forEach(b => b.addEventListener('click', () => {
  dfilter = b.dataset.c;
  document.querySelectorAll('button[data-c]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderDos();
}));
dq.addEventListener('input', renderDos);

// ---- Radar ---------------------------------------------------------------
let rfilter = 'all';
const rq = document.getElementById('rq'), rlist = document.getElementById('rlist');
const CAT = {audit:'🔐 audit',contracten:'🧱 contract',vacature:'💼 vacature',techniek:'🧪 techniek',bounty:'🛡 bounty',sdk:'📦 sdk'};
function renderRad(){
  if (!RAD || RAD.error) { rlist.innerHTML = '<div class="empty">Radar niet te laden' + (RAD && RAD.error ? ' (' + escape(RAD.error) + ')' : '') + '.</div>'; return; }
  const term = rq.value.trim().toLowerCase();
  const rows = (RAD.items||[]).filter(it => (rfilter === 'all' || it.cat === rfilter) &&
    (!term || (String(it.title) + ' ' + JSON.stringify(it.meta||{})).toLowerCase().includes(term)))
    .sort((a,b) => String(b.date).localeCompare(String(a.date)) || String(a.cat).localeCompare(String(b.cat)));
  const down = Object.entries(RAD.health||{}).filter(e => e[1] && e[1].ok === false).map(e => e[0]);
  const head = down.length ? '<div class="warn">⚠️ In storing: ' + escape(down.join(', ')) + '</div>' : '';
  if (!rows.length) { rlist.innerHTML = head + '<div class="empty">Niets gevonden.</div>'; return; }
  rlist.innerHTML = head + '<div class="note">' + rows.length + ' items</div>' + rows.slice(0, 400).map(it => {
    const m = it.meta || {};
    const bits = ['<span class="k">' + escape(CAT[it.cat] || it.cat) + '</span>', day(it.date)];
    if (m.forum) bits.push(escape(m.forum));
    if (m.repo) bits.push(escape(m.repo));
    if (m.chain) bits.push(escape(m.chain));
    if (m.company) bits.push(escape(m.company));
    if (m.starts) bits.push('start ' + escape(m.starts));
    if (m.ends) bits.push('eind ' + escape(m.ends));
    if (m.prize) bits.push(escape(Number(m.prize).toLocaleString('nl-NL')) + ' ' + escape(m.token || ''));
    if (m.type) bits.push(escape(m.type));
    if (m.ecosystem) bits.push(escape(m.ecosystem));
    if (m.version) bits.push('v' + escape(m.version));
    return '<div class="row"><h2>' + link(it.url, it.title) + '</h2>' +
      (m.about ? '<div class="desc">' + escape(m.about) + '</div>' : '') +
      '<div class="meta">' + bits.map(b => '<span>' + b + '</span>').join('') + '</div></div>';
  }).join('');
}
document.querySelectorAll('button[data-r]').forEach(b => b.addEventListener('click', () => {
  rfilter = b.dataset.r;
  document.querySelectorAll('button[data-r]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderRad();
}));
rq.addEventListener('input', renderRad);

// ---- Airdrops ------------------------------------------------------------
const alist = document.getElementById('alist');
function renderAir(){
  if (!RAD || RAD.error) { alist.innerHTML = '<div class="empty">Niet te laden.</div>'; return; }
  const rows = RAD.airdrops || [];
  if (!rows.length) { alist.innerHTML = '<div class="empty">Op dit moment geen kandidaten met genoeg signalen.</div>'; return; }
  alist.innerHTML = rows.map(a => '<div class="row" data-kind="launched"><h2><span class="score hi">' + escape(a.score) + '</span>' +
    '<a href="#dossiers" data-open="' + escape(a.id) + '">' + escape(a.name) + '</a></h2>' +
    '<div class="meta"><span class="k">' + escape(STAGE[a.stage] || a.stage || '') + '</span><span>' + escape((a.why||[]).join(' · ')) + '</span>' +
    (a.website ? '<span>' + link(a.website, 'site') + '</span>' : '') + '</div></div>').join('');
}

// Klik op een airdrop-kandidaat: open het dossier, gefilterd op dat project.
alist.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-open]');
  if (!a) return;
  dq.value = a.dataset.open;
  dfilter = 'all';
  document.querySelectorAll('button[data-c]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.c === 'all')));
});

const lc = document.getElementById('lastchange');
if (lc && lc.dataset.ts) lc.textContent = fmt(lc.dataset.ts);
render();
show();
</script></body></html>`;

  // Pad op aanroepmoment lezen, niet bij import: anders is het niet testbaar
  // en negeert een laat gezette env-variabele de configuratie.
  const out = process.env.CHAINWATCH_DOCS || 'docs';
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(`${out}/index.html`, html);
}
