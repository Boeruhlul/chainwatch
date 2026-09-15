import fs from 'node:fs/promises';
import { esc } from './util.js';

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

  const html = `<!doctype html>
<html lang="nl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>chainwatch</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1a1a18;--mut:#6b6b64;--line:#e4e4df;--card:#fff;
--main:#1a7f5a;--test:#8a5a00;--up:#2f5fa8;--dev:#6b4ea8;--prop:#8a8a80}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f0efec;--mut:#9a9a92;--line:#2b2b28;--card:#1c1c1a;
--main:#4ec99a;--test:#e0a33a;--up:#7aa7e8;--dev:#b29ae8;--prop:#9a9a92}}
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
.row h2{font-size:.9375rem;margin:0 0 3px;font-weight:600}
.row h2 a{color:inherit;text-decoration:none}.row h2 a:hover{text-decoration:underline}
.meta{color:var(--mut);font-size:.8125rem;display:flex;flex-wrap:wrap;gap:4px 10px}
.k{font-size:.6875rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.k.mainnet{color:var(--main)}.k.testnet{color:var(--test)}.k.upcoming{color:var(--up)}
.k.devnet{color:var(--dev)}.k.proposal{color:var(--prop)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8125em;
background:color-mix(in srgb,var(--fg) 7%,transparent);padding:1px 5px;border-radius:4px}
.pill{display:inline-block;font-size:.6875rem;padding:2px 8px;border-radius:999px;margin-right:4px;
background:color-mix(in srgb,var(--main) 15%,transparent);color:var(--main)}
.pill.bad{background:color-mix(in srgb,#d4183d 15%,transparent);color:#d4183d}
.empty{color:var(--mut);padding:32px;text-align:center}
footer{margin-top:32px;color:var(--mut);font-size:.75rem}
</style></head><body><div class="wrap">
<h1>chainwatch</h1>
<div class="sub">Laatste detectie: <span id="lastchange" data-ts="${esc(lastChange || '')}">—</span> · bronnen: ${sourceStatus}</div>
<div class="stats">
${['mainnet', 'testnet', 'upcoming', 'devnet', 'proposal']
  .map((k) => `<div class="stat"><b>${counts[k] || 0}</b><span>${k}</span></div>`)
  .join('')}
</div>
<div class="filters">
<button data-f="all" aria-pressed="true">Alles</button>
<button data-f="mainnet" aria-pressed="false">Mainnet</button>
<button data-f="testnet" aria-pressed="false">Testnet</button>
<button data-f="upcoming" aria-pressed="false">Upcoming</button>
<button data-f="proposal" aria-pressed="false">Pre-launch</button>
<input type="search" id="q" placeholder="Zoek op naam of chain ID…">
</div>
<div class="list" id="list"></div>
<footer>Gegenereerd door chainwatch · ${rows.length} detecties bewaard</footer>
</div>
<script>
// '<' escapen: een chain-naam met een sluitende script-tag zou dit blok
// anders voortijdig afbreken (XSS via PR-titels en chain-namen).
const DATA = ${JSON.stringify(rows).replace(/</g, '\\u003c').replace(/ | /g, (m) => (m === ' ' ? '\\u2028' : '\\u2029'))};
const list = document.getElementById('list'), q = document.getElementById('q');
let filter = 'all';
const fmt = d => { try { return new Date(d).toLocaleString('nl-NL',{dateStyle:'medium',timeStyle:'short'}); } catch { return d; } };
const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(){
  const term = q.value.trim().toLowerCase();
  const rows = DATA.filter(c =>
    (filter === 'all' || c.kind === filter) &&
    (!term || (c.name||'').toLowerCase().includes(term) || String(c.chainId||'').includes(term))
  );
  if (!rows.length) { list.innerHTML = '<div class="empty">Niets gevonden.</div>'; return; }
  list.innerHTML = rows.map(c => {
    const bits = [];
    if (c.chainId != null) bits.push('<code>' + escape(c.chainId) + '</code>');
    if (c.ecosystem && c.ecosystem !== 'onbekend') bits.push(escape(c.ecosystem));
    if (c.nativeCurrency) bits.push(escape(c.nativeCurrency));
    if (c.faucets && c.faucets.length) bits.push('<a href="' + escape(c.faucets[0]) + '">faucet</a>');
    bits.push('bron: ' + escape(c.source));
    bits.push(fmt(c.detectedAt));
    return '<div class="row" data-kind="' + escape(c.kind) + '">' +
      '<h2><a href="' + escape(c.url) + '" target="_blank" rel="noopener">' + escape(c.name) + '</a></h2>' +
      '<div class="meta"><span class="k ' + escape(c.kind) + '">' + escape(c.kind) + '</span>' +
      bits.map(b => '<span>' + b + '</span>').join('') + '</div></div>';
  }).join('');
}
document.querySelectorAll('button[data-f]').forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('button[data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
q.addEventListener('input', render);
const lc = document.getElementById('lastchange');
if (lc && lc.dataset.ts) lc.textContent = fmt(lc.dataset.ts);
render();
</script></body></html>`;

  // Pad op aanroepmoment lezen, niet bij import: anders is het niet testbaar
  // en negeert een laat gezette env-variabele de configuratie.
  const out = process.env.CHAINWATCH_DOCS || 'docs';
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(`${out}/index.html`, html);
}
