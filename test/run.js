/**
 * Test de diff-, dedupe- en anomalielogica zonder netwerk.
 * Injecteert een fake bron via CHAINWATCH_FIXTURE.
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import http from 'node:http';

const run = promisify(execFile);
const TMP = 'test/.tmp';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

async function reset() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(`${TMP}/data`, { recursive: true });
}

async function watch(fixture, env = {}) {
  await fs.writeFile(`${TMP}/fixture.json`, JSON.stringify(fixture));
  const { stdout, stderr } = await run('node', ['src/index.js'], {
    env: {
      ...process.env,
      CHAINWATCH_DATA: `${TMP}/data`,
      CHAINWATCH_DOCS: `${TMP}/docs`,
      CHAINWATCH_FIXTURE: `${TMP}/fixture.json`,
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
      PROBE_ENABLED: 'false',
      ...env,
    },
  });
  return stdout + stderr;
}

/** Mini webserver die vaste paginas serveert, voor de verrijkingstests. */
function htmlServer(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url.split('?')[0]];
    if (body === undefined) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    );
  });
}

/** Mini Telegram-server: verzamelt berichten of faalt op commando. */
function tgServer({ failAll = false } = {}) {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failAll) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, description: 'bot was blocked by the user' }));
      }
      try { sent.push(JSON.parse(body)); } catch { /* negeer */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    );
  });
}

async function watchTg(fixture, tg, env = {}) {
  await fs.writeFile(`${TMP}/fixture.json`, JSON.stringify(fixture));
  try {
    const r = await run('node', ['src/index.js'], {
      env: {
        ...process.env,
        CHAINWATCH_DATA: `${TMP}/data`, CHAINWATCH_DOCS: `${TMP}/docs`,
        CHAINWATCH_FIXTURE: `${TMP}/fixture.json`, CHAINWATCH_TG_API: tg.url,
        TELEGRAM_BOT_TOKEN: 'testtoken', TELEGRAM_CHAT_ID: '123',
        PROBE_ENABLED: 'false', ...env,
      },
    });
    return r.stdout + r.stderr;
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

const chain = (id, name, extra = {}) => ({ chainId: id, name, rpc: [`https://rpc.${id}.test`], ...extra });

console.log('\nchainwatch tests\n');
await reset();

await t('bootstrap alert niet op de eerste run', async () => {
  const out = await watch([chain(1, 'Ethereum'), chain(137, 'Polygon')]);
  assert.match(out, /bootstrap/, 'bootstrap niet gedetecteerd');
  assert.match(out, /0 alertwaardig/, 'stuurde alerts op eerste run');
});

await t('state is weggeschreven na bootstrap', async () => {
  const seen = JSON.parse(await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8'));
  assert.deepEqual(seen.sort(), ['evm:1', 'evm:137'].sort());
});

await t('detecteert alleen de echt nieuwe chain', async () => {
  const out = await watch([chain(1, 'Ethereum'), chain(137, 'Polygon'), chain(999, 'Nieuwnet')]);
  assert.match(out, /1 gedetecteerd, 1 alertwaardig/);
  assert.match(out, /NIEUWE MAINNET/);
  assert.match(out, /Nieuwnet/);
});

await t('tweede run met dezelfde data levert niets op', async () => {
  const out = await watch([chain(1, 'Ethereum'), chain(137, 'Polygon'), chain(999, 'Nieuwnet')]);
  assert.match(out, /0 gedetecteerd, 0 alertwaardig/);
});

await t('classificeert testnet via naam en via faucet', async () => {
  const out = await watch([
    chain(1, 'Ethereum'), chain(137, 'Polygon'), chain(999, 'Nieuwnet'),
    chain(1001, 'Nieuwnet Testnet'),
    chain(1002, 'Stealthchain', { faucets: ['https://faucet.stealth.xyz'] }),
  ]);
  assert.match(out, /NIEUWE TESTNET[\s\S]*Nieuwnet Testnet/);
  assert.match(out, /NIEUWE TESTNET[\s\S]*Stealthchain/);
  assert.match(out, /faucet\.stealth\.xyz/i, 'faucet-URL ontbreekt in alert');
});

await t('WATCH_KINDS filtert testnets weg', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  const out = await watch([chain(1, 'Ethereum'), chain(5, 'Foo Testnet'), chain(6, 'Bar')], {
    WATCH_KINDS: 'mainnet',
  });
  assert.match(out, /2 gedetecteerd, 1 alertwaardig/);
  assert.doesNotMatch(out, /Foo Testnet/);
});

await t('incubating status wordt upcoming', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  const out = await watch([chain(1, 'Ethereum'), chain(7, 'Toekomstchain', { status: 'incubating' })]);
  assert.match(out, /NIEUW GETRACKT PROJECT[\s\S]*Toekomstchain/);
});

await t('deprecated chains worden genegeerd', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  const out = await watch([chain(1, 'Ethereum'), chain(8, 'Doodchain', { status: 'deprecated' })]);
  assert.match(out, /0 gedetecteerd/);
});

await t('anomalie schakelt over op één samenvatting', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  const many = [chain(1, 'Ethereum'), ...Array.from({ length: 120 }, (_, i) => chain(2000 + i, `Spam ${i}`))];
  const out = await watch(many, { MAX_ALERTS_PER_RUN: '25' });
  assert.match(out, /ANOMALIE/);
  assert.match(out, /120 nieuwe netwerken gedetecteerd/);
  assert.doesNotMatch(out, /bericht 2\/|Spam 0[\s\S]*NIEUWE MAINNET[\s\S]*Spam 1\b/);
});

await t('kapotte bron laat state ongemoeid en meldt de fout', async () => {
  await reset();
  await watch([chain(1, 'Ethereum'), chain(2, 'Twee')]);
  const out = await watch('BOOM');
  assert.match(out, /FOUT/);
  const seen = JSON.parse(await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8'));
  assert.deepEqual(seen.sort(), ['evm:1', 'evm:2'], 'seen-set aangetast door mislukte fetch');
  assert.match(out, /bron\(nen\) falen/);
});

await t('dashboard is geschreven en bevat de detectie', async () => {
  const html = await fs.readFile(`${TMP}/docs/index.html`, 'utf8');
  assert.match(html, /chainwatch/);
  assert.match(html, /const DATA = \[/);
});

await t('dry-run schrijft geen state', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  const before = await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8');
  await run('node', ['src/index.js', '--dry-run'], {
    env: { ...process.env, CHAINWATCH_DATA: `${TMP}/data`, CHAINWATCH_DOCS: `${TMP}/docs`,
           CHAINWATCH_FIXTURE: `${TMP}/fixture.json`, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' },
  });
  await fs.writeFile(`${TMP}/fixture.json`, JSON.stringify([chain(1, 'Ethereum'), chain(3, 'Drie')]));
  await run('node', ['src/index.js', '--dry-run'], {
    env: { ...process.env, CHAINWATCH_DATA: `${TMP}/data`, CHAINWATCH_DOCS: `${TMP}/docs`,
           CHAINWATCH_FIXTURE: `${TMP}/fixture.json`, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' },
  });
  const after = await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8');
  assert.equal(before, after, 'dry-run heeft state gemuteerd');
});

// ---- regressietests voor eerder gevonden bugs --------------------------------

await t('S1: mislukte Telegram-alert blijft buiten de state en wordt hervat', async () => {
  await reset();
  const bad = await tgServer({ failAll: true });
  await watchTg([chain(1, 'Ethereum')], bad);                       // bootstrap
  const out1 = await watchTg([chain(1, 'Ethereum'), chain(42, 'Gemiste Chain')], bad);
  bad.close();
  assert.match(out1, /niet afgeleverd/, 'niet-afgeleverde chain niet herkend');
  const seen = JSON.parse(await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8'));
  assert.ok(!seen.includes('evm:42'), 'mislukte chain toch als gezien weggeschreven');

  // Telegram werkt weer: de gemiste chain moet alsnog binnenkomen
  const good = await tgServer();
  await watchTg([chain(1, 'Ethereum'), chain(42, 'Gemiste Chain')], good);
  good.close();
  assert.equal(good.sent.length, 1, 'chain niet opnieuw geprobeerd na herstel');
  assert.match(good.sent[0].text, /Gemiste Chain/);
  const seen2 = JSON.parse(await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8'));
  assert.ok(seen2.includes('evm:42'), 'chain na succesvolle aflevering niet vastgelegd');
});

await t('S1b: geslaagde alerts worden niet opnieuw verstuurd na een deelfout', async () => {
  const seen = JSON.parse(await fs.readFile(`${TMP}/data/seen/fixture.json`, 'utf8'));
  assert.ok(seen.includes('evm:1') && seen.includes('evm:42'));
  const good = await tgServer();
  const out = await watchTg([chain(1, 'Ethereum'), chain(42, 'Gemiste Chain')], good);
  good.close();
  assert.equal(good.sent.length, 0, 'dubbele alert verstuurd');
  assert.match(out, /0 gedetecteerd/);
});

await t('S2: pre-launch project alerteert opnieuw zodra het live gaat', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg([chain(1, 'Ethereum'), chain(50, 'Foobar', { status: 'incubating' })], tg);
  assert.equal(tg.sent.length, 1, 'pre-launch signaal ontbreekt');
  assert.match(tg.sent[0].text, /NIEUW GETRACKT PROJECT/);
  // Zelfde project, nu echt live met een eigen chain ID
  const out2 = await watchTg(
    [chain(1, 'Ethereum'), chain(50, 'Foobar', { status: 'incubating' }), chain(7777, 'Foobar Network')], tg);
  tg.close();
  assert.match(out2, /1 gedetecteerd, 1 alertwaardig/, 'launch stil weggefilterd als duplicaat');
  assert.equal(tg.sent.length, 2, 'launch-alert niet verstuurd');
  assert.match(tg.sent[1].text, /NIEUWE MAINNET/);
});

await t('S3: lange namen laten het samenvattingsbericht niet over de limiet gaan', async () => {
  const { summaryMessage, limits } = await import('../src/notify.js');
  const long = Array.from({ length: 120 }, (_, i) => ({
    key: `k${i}`, source: 'ethlists-pr', kind: 'proposal', chainId: 100000 + i,
    name: `Add new chain definition for SomeVeryLongProjectName Network Mainnet Deployment ${i} `.repeat(3),
  }));
  const msg = summaryMessage(long, 'bron ethlists-pr leverde ongewoon veel records');
  assert.ok(msg.length <= limits.TG_LIMIT, `samenvatting is ${msg.length} tekens`);
  assert.match(msg, /en \d+ meer/);
});

await t('S3b: de anomalie-samenvatting benoemt welke bron het betreft', async () => {
  const { summaryMessage } = await import('../src/notify.js');
  const msg = summaryMessage(
    [{ key: 'a', name: 'X', kind: 'mainnet', source: 'defillama' }],
    'bron defillama leverde ongewoon veel nieuwe records'
  );
  assert.match(msg, /defillama/);
});

await t('S4: corrupt state-bestand faalt hard i.p.v. stil te bootstrappen', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await fs.writeFile(`${TMP}/data/seen/fixture.json`, '["evm:1", ');  // afgekapt
  const out = await watchTg([chain(1, 'Ethereum'), chain(60, 'Zou Gemist Worden')], tg);
  tg.close();
  assert.match(out, /corrupt/i, 'corrupt bestand niet gedetecteerd');
  assert.doesNotMatch(out, /\(bootstrap\)/, 'stil gebootstrapt op corrupte state');
  assert.doesNotMatch(out, /gedetecteerd/, 'run ging door op corrupte state');
  assert.equal(tg.sent.length, 1, 'geen waarschuwing verstuurd over de kapotte state');
  assert.match(tg.sent[0].text, /corrupt|gecrasht/i);
  assert.doesNotMatch(tg.sent[0].text, /Zou Gemist Worden/, 'chain-alert verstuurd ondanks kapotte state');
});

await t('S10: gelijkende projectnamen botsen niet in de dedupe', async () => {
  const { nameKey } = await import('../src/util.js');
  assert.notEqual(nameKey('Oasis Network', 'mainnet'), nameKey('Oasis Protocol', 'mainnet'));
  assert.notEqual(nameKey('🚀', 'mainnet'), nameKey('（新）链', 'mainnet'));
  assert.ok(!nameKey('🚀', 'mainnet').startsWith(':'), 'lege sleutel voor niet-ASCII naam');
  // maar echte varianten moeten wél samenvallen
  assert.equal(nameKey('Berachain', 'testnet'), nameKey('Berachain Testnet', 'testnet'));
});

await t('S11: PR-titels worden correct opgeschoond', async () => {
  const { default: src } = await import('../src/sources/ethlists-pr.js');
  const clean = (title) =>
    title
      .replace(/^\s*(?:\[[^\]]*\]\s*)?(?:feat|fix|chore|docs)\s*:\s*/i, '')
      .replace(/^\s*(adding|creating|updating|added|create|update|adds|add|new)\b\s*/i, '')
      .replace(/^\s*(chain|network)\b\s*:?\s*/i, '')
      .replace(/^[:\-–\s]+/, '')
      .trim();
  assert.equal(clean('Adding chain Foobar'), 'Foobar');
  assert.equal(clean('Add chain: Foobar'), 'Foobar');
  assert.equal(clean('feat: add Monad'), 'Monad');
  assert.equal(clean('Add Lisk Sepolia'), 'Lisk Sepolia');
  assert.ok(src.enrich, 'enrich ontbreekt: PR-bevestiging via files-API');
});

await t('S7: chain-naam met een sluitende script-tag breekt het dashboard niet', async () => {
  const { buildDashboard } = await import('../src/dashboard.js');
  process.env.CHAINWATCH_DOCS = `${TMP}/docs`;
  await buildDashboard(
    [{ key: 'x', name: '</script><img src=x onerror=alert(1)>', kind: 'mainnet', source: 'test',
       url: 'https://x.test', detectedAt: new Date().toISOString() }],
    { health: {} }
  );
  const html = await fs.readFile(`${TMP}/docs/index.html`, 'utf8');
  const scriptBody = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</' + 'script>'));
  assert.ok(!scriptBody.includes('</' + 'script>'), 'script-blok voortijdig afgebroken (XSS)');
  assert.match(html, /\\u003c/, 'geen escaping toegepast op < in de data');
});

await t('S8: run zonder detecties laat het dashboard byte-identiek', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  const a = await fs.readFile(`${TMP}/docs/index.html`, 'utf8');
  await new Promise((r) => setTimeout(r, 1100));
  await watchTg([chain(1, 'Ethereum')], tg);
  tg.close();
  const b = await fs.readFile(`${TMP}/docs/index.html`, 'utf8');
  assert.equal(a, b, 'dashboard verandert zonder detectie -> commit bij elke run');
});

await t('S6: bronfout wordt niet elke run opnieuw gemeld', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg('BOOM', tg);
  const n1 = tg.sent.length;
  assert.equal(n1, 1, 'eerste bronfout niet gemeld');
  assert.match(tg.sent[0].text, /falen/);
  await watchTg('BOOM', tg);
  tg.close();
  assert.equal(tg.sent.length, n1, 'zelfde bronfout opnieuw gemeld binnen de stilteperiode');
});


// ---------------------------------------------------------------------------
// Verrijking, scoring en de nieuwe bronparsers.
// ---------------------------------------------------------------------------

const { apexOf, parseSocials, websiteCandidates, enrichOne } = await import('../src/enrich.js');
const { scoreChain, badgeFor } = await import('../src/score.js');
const { parseBlocks } = await import('../src/sources/hyperlane.js');
const { formatChain } = await import('../src/notify.js');

await t('E1: apex-afleiding kent meerledige TLDs en negeert IPs', async () => {
  assert.equal(apexOf('https://rpc-os.avicoin.org/v1'), 'avicoin.org');
  assert.equal(apexOf('explorer.foo.co.uk'), 'foo.co.uk');
  assert.equal(apexOf('https://WWW.Example.COM/'), 'example.com');
  assert.equal(apexOf('http://127.0.0.1:8545'), null, 'IP is geen domein');
  assert.equal(apexOf('localhost'), null);
  assert.equal(apexOf(''), null);
  assert.equal(apexOf(null), null);
});

await t('E2: infra-domeinen worden niet als projectsite aangezien', async () => {
  const c = {
    website: null,
    explorers: ['https://eth.blockscout.com/'],
    rpc: ['https://foo.llamarpc.com', 'https://rpc.mychain.xyz'],
  };
  assert.deepEqual(websiteCandidates(c), ['mychain.xyz']);
});

await t('E3: socials worden uit ruwe HTML gehaald, ruislinks niet', async () => {
  const html = `<html><head><title>Numen Chain</title>
    <meta property="og:description" content="Een snelle L2 voor betalingen">
    </head><body>
    <a href="https://twitter.com/intent/tweet?text=hi">tweet</a>
    <a href="https://x.com/numenchain">X</a>
    <a href="https://t.me/numenchain">TG</a>
    <a href="https://discord.gg/abc123XY">Discord</a>
    <a href="https://github.com/features/actions">actions</a>
    <a href="https://github.com/numenlabs">GitHub</a>
    <a href="https://docs.numen.xyz/start">Docs</a>
    </body></html>`;
  const s = parseSocials(html, { apex: 'numen.xyz' });
  assert.equal(s.x, 'https://x.com/numenchain', 'intent-link mag niet als handle tellen');
  assert.equal(s.telegram, 'https://t.me/numenchain');
  assert.equal(s.discord, 'https://discord.gg/abc123XY');
  assert.equal(s.github, 'https://github.com/numenlabs', 'github.com/features is geen org');
  assert.equal(s.docs, 'https://docs.numen.xyz/start');
  assert.equal(s.title, 'Numen Chain');
  assert.equal(s.description, 'Een snelle L2 voor betalingen');
});

await t('E4: meest voorkomende handle wint van een losse vermelding', async () => {
  const html = `
    <a href="https://x.com/randomguy">via</a>
    <a href="https://x.com/therealchain">header</a>
    <a href="https://x.com/therealchain">footer</a>`;
  assert.equal(parseSocials(html).x, 'https://x.com/therealchain');
});

await t('E5: HTML-entities in titel en omschrijving worden gedecodeerd', async () => {
  const s = parseSocials('<title>Foo &amp; Bar</title>');
  assert.equal(s.title, 'Foo & Bar');
});

await t('E6: verrijking is uit te zetten en respecteert de limiet', async () => {
  const { enrichChains } = await import('../src/enrich.js');
  const chains = Array.from({ length: 5 }, (_, i) => ({ name: `c${i}`, website: 'https://x.invalid', rpc: [], explorers: [] }));
  process.env.ENRICH_SOCIALS = 'false';
  const same = await enrichChains(chains, { limit: 5, budgetMs: 1000 });
  delete process.env.ENRICH_SOCIALS;
  assert.equal(same, chains, 'uitgeschakelde verrijking geeft de lijst ongewijzigd terug');
  assert.ok(chains.every((c) => !c.socials && !c.domain));

  // Met een verlopen budget mag er geen enkele netwerkpoging meer gedaan worden.
  const t0 = Date.now();
  await enrichChains(chains, { limit: 5, budgetMs: -1 });
  assert.ok(Date.now() - t0 < 2000, 'verlopen budget moet meteen stoppen');
});

await t('E7: verrijking faalt nooit hard op een onbereikbare site', async () => {
  const c = { name: 'Dood', website: 'https://dit-domein-bestaat-niet-xyzzy.invalid', rpc: [], explorers: [] };
  const extra = await enrichOne(c, { deadline: Date.now() + 3000 });
  assert.equal(typeof extra, 'object');
});

await t('E8: score zet pre-launch met vers domein boven een bekende cross-listing', async () => {
  const vers = scoreChain({
    kind: 'proposal', source: 'ethlists-pr', domain: { ageDays: 5 }, github: { ageDays: 20 },
  });
  const oud = scoreChain({
    kind: 'mainnet', source: 'coingecko', crossListing: true, domain: { ageDays: 2000 }, tvl: 5e6,
  });
  assert.ok(vers.score > oud.score, `${vers.score} moet hoger zijn dan ${oud.score}`);
  assert.equal(badgeFor(vers.score).icon, '🔥');
  assert.ok(vers.reasons.includes('pre-launch'));
  assert.ok(vers.reasons.some((r) => r.includes('domein')));
});

await t('E9: score blijft binnen 0 en 100', async () => {
  for (const c of [
    { kind: 'proposal', source: 'ethlists-pr', domain: { ageDays: 0 }, github: { ageDays: 0 } },
    { kind: 'devnet', source: 'coingecko', crossListing: true, tvl: 1e9, domain: { ageDays: 4000 } },
    {},
  ]) {
    const { score } = scoreChain(c);
    assert.ok(score >= 0 && score <= 100, `score buiten bereik: ${score}`);
  }
});

await t('E10: bericht toont socials, domeinleeftijd en prioriteit', async () => {
  const text = formatChain({
    kind: 'proposal', name: 'VORA Chain', chainId: 3318, ecosystem: 'EVM',
    source: 'ethlists-pr', url: 'https://github.com/ethereum-lists/chains/pull/8737',
    website: 'https://vora.xyz', socials: { x: 'https://x.com/vorachain', telegram: 'https://t.me/vora' },
    domain: { ageDays: 6 }, score: 78, reasons: ['pre-launch', 'domein 6d oud'],
  });
  assert.match(text, /x\.com\/vorachain/);
  assert.match(text, /t\.me\/vora/);
  assert.match(text, /6 dagen oud/);
  assert.match(text, /prioriteit 78\/100/);
  assert.match(text, /🔥/);
});

await t('E11: bericht zonder verrijking blijft geldig en binnen de limiet', async () => {
  const text = formatChain({
    kind: 'mainnet', name: 'X'.repeat(400), source: 'chainlist', url: 'https://chainlist.org/chain/1',
  });
  assert.ok(text.length <= 3800, `te lang: ${text.length}`);
  assert.match(text, /prioriteit 0\/100/);
  assert.doesNotMatch(text, /undefined/);
});

await t('E12: HTML in chain-naam wordt geescaped in het bericht', async () => {
  const text = formatChain({
    kind: 'mainnet', name: '<b>pwn</b>', source: 'chainlist', url: 'https://x.test',
    socials: { x: 'https://x.com/<script>' },
  });
  assert.doesNotMatch(text.replace(/<\/?(b|i|code)>/g, ''), /<script|<b>pwn/);
});

await t('E13: hyperlane-YAML wordt in blokken per chain gesplitst', async () => {
  const yaml = [
    'abstract:',
    '  chainId: 2741',
    '  displayName: Abstract',
    '  protocol: ethereum',
    'somenewchain:',
    '  chainId: 987654',
    '  displayName: Some New Chain',
    '  isTestnet: true',
    '  protocol: ethereum',
  ].join('\n');
  const blocks = parseBlocks(yaml);
  assert.equal(blocks.size, 2);
  assert.match(blocks.get('somenewchain'), /chainId: 987654/);
  assert.doesNotMatch(blocks.get('abstract'), /987654/, 'blokken mogen niet in elkaar lekken');
});


// ---------------------------------------------------------------------------
// Launch-detectie: RPC-polling op de wachtlijst.
// ---------------------------------------------------------------------------

const { probeRpc, toPendingEntry, restorePending, probePending } = await import('../src/probe.js');

/** Mini-node. `state.alive` bepaalt of hij antwoordt; `state.flavor` welk soort. */
function rpcServer(state = { alive: true, flavor: 'evm', chainId: 7777, block: 3 }) {
  const server = http.createServer((req, res) => {
    if (!state.alive) { res.writeHead(503); return res.end('not yet'); }
    if (state.flavor === 'cosmos') {
      if (!req.url.startsWith('/status')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        result: { node_info: { network: 'newchain-1' }, sync_info: { latest_block_height: String(state.block) } },
      }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let method = '';
      try { method = JSON.parse(body).method; } catch { /* leeg */ }
      const result =
        method === 'eth_chainId' ? '0x' + state.chainId.toString(16) :
        method === 'eth_blockNumber' ? '0x' + state.block.toString(16) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result === null ? { jsonrpc: '2.0', id: 1, error: { message: 'unsupported' } }
                                              : { jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    );
  });
}

await t('P1: EVM-node wordt herkend met chain ID en blokhoogte', async () => {
  const s = await rpcServer({ alive: true, flavor: 'evm', chainId: 3318, block: 42 });
  const r = await probeRpc(s.url);
  s.close();
  assert.equal(r.live, true);
  assert.equal(r.flavor, 'evm');
  assert.equal(r.chainId, 3318);
  assert.equal(r.block, 42);
});

await t('P2: Tendermint-node wordt herkend via /status', async () => {
  const s = await rpcServer({ alive: true, flavor: 'cosmos', block: 128 });
  const r = await probeRpc(s.url);
  s.close();
  assert.equal(r.live, true);
  assert.equal(r.flavor, 'cosmos');
  assert.equal(r.chainId, 'newchain-1');
  assert.equal(r.block, 128);
});

await t('P3: een dode of onzinnige RPC levert nooit een launch op', async () => {
  const s = await rpcServer({ alive: false, flavor: 'evm', chainId: 1, block: 1 });
  assert.equal((await probeRpc(s.url)).live, false, '503 mag niet als live tellen');
  s.close();
  assert.equal((await probeRpc('ftp://nope')).live, false);
  assert.equal((await probeRpc('')).live, false);
  assert.equal((await probeRpc(null)).live, false);
});

await t('P4: chain zonder RPC komt niet op de wachtlijst', async () => {
  assert.equal(toPendingEntry({ key: 'a', name: 'X', rpc: [] }), null);
  assert.equal(toPendingEntry({ key: 'a', name: 'X', rpc: ['${INFURA_KEY}'] }), null);
  const e = toPendingEntry({ key: 'a', name: 'X', kind: 'proposal', rpc: ['https://rpc.x.test'] });
  assert.equal(e.key, 'a');
  assert.ok(e.liveNameKey.endsWith(':main'), 'liveNameKey moet de main-bucket zijn');
});

await t('P5: verlopen wachtlijst-items vallen af zonder bericht', async () => {
  const oud = { key: 'oud', name: 'Oud', kind: 'proposal', rpc: ['http://127.0.0.1:1/'], addedAt: '2020-01-01T00:00:00.000Z' };
  const { launched, keep } = await probePending([oud], { ttlDays: 30, budgetMs: 2000 });
  assert.equal(launched.length, 0);
  assert.equal(keep.length, 0, 'verlopen item blijft op de lijst staan');
});

await t('P6: launch-record is terug te draaien naar zijn wachtlijst-entry', async () => {
  const e = toPendingEntry({ key: 'evm:9', name: 'Later', kind: 'upcoming', chainId: 9, rpc: ['https://rpc.x.test'] });
  const launched = { ...e, key: `launch:${e.key}`, kind: 'launched', pendingKey: e.key, pendingKind: e.kind,
                     expectedChainId: 9, block: 1, flavor: 'evm', score: 95, reasons: [], detectedAt: 'nu' };
  const back = restorePending(launched);
  assert.equal(back.key, 'evm:9');
  assert.equal(back.kind, 'upcoming');
  assert.equal(back.chainId, 9);
  assert.ok(!('block' in back) && !('score' in back), 'launch-velden lekken terug de wachtlijst in');
});

await t('P7: end-to-end — pre-launch chain komt op de lijst en alerteert zodra de RPC antwoordt', async () => {
  await reset();
  const node = await rpcServer({ alive: false, flavor: 'evm', chainId: 7777, block: 5 });
  const tg = await tgServer();
  const probeOn = { PROBE_ENABLED: 'true' };

  await watchTg([chain(1, 'Ethereum')], tg, probeOn); // bootstrap

  // Chain wordt als pre-launch gedetecteerd; de RPC leeft nog niet.
  await watchTg(
    [chain(1, 'Ethereum'), { chainId: 7777, name: 'Sluipchain', status: 'incubating', rpc: [node.url] }],
    tg, probeOn
  );
  assert.equal(tg.sent.length, 1, 'pre-launch signaal ontbreekt');
  assert.match(tg.sent[0].text, /NIEUW GETRACKT PROJECT[\s\S]*Sluipchain/);
  const pending = JSON.parse(await fs.readFile(`${TMP}/data/pending.json`, 'utf8'));
  assert.equal(pending.length, 1, 'pre-launch chain niet op de wachtlijst gezet');
  assert.equal(pending[0].rpc[0], node.url);

  // Genesis: dezelfde RPC antwoordt nu.
  node.state.alive = true;
  const out3 = await watchTg(
    [chain(1, 'Ethereum'), { chainId: 7777, name: 'Sluipchain', status: 'incubating', rpc: [node.url] }],
    tg, probeOn
  );
  node.close();
  tg.close();

  assert.match(out3, /0 gedetecteerd/, 'bron leverde onterecht een nieuwe detectie');
  assert.match(out3, /1 live gegaan/);
  assert.equal(tg.sent.length, 2, 'launch-alert niet verstuurd');
  const msg = tg.sent[1].text;
  assert.match(msg, /CHAIN IS LIVE/);
  assert.match(msg, /Sluipchain/);
  assert.match(msg, /blok 5/);
  assert.match(msg, /Werkende RPC/);
  const pending2 = JSON.parse(await fs.readFile(`${TMP}/data/pending.json`, 'utf8'));
  assert.equal(pending2.length, 0, 'live gegane chain blijft op de wachtlijst staan');
});

await t('P8: niet-afgeleverde launch-alert blijft op de wachtlijst staan', async () => {
  await reset();
  const node = await rpcServer({ alive: false, flavor: 'evm', chainId: 8888, block: 2 });
  const probeOn = { PROBE_ENABLED: 'true' };

  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg, probeOn);
  await watchTg(
    [chain(1, 'Ethereum'), { chainId: 8888, name: 'Hikchain', status: 'incubating', rpc: [node.url] }],
    tg, probeOn
  );
  tg.close();

  // Telegram valt uit op precies het moment dat de chain live gaat.
  node.state.alive = true;
  const bad = await tgServer({ failAll: true });
  const out = await watchTg(
    [chain(1, 'Ethereum'), { chainId: 8888, name: 'Hikchain', status: 'incubating', rpc: [node.url] }],
    bad, probeOn
  );
  bad.close();
  assert.match(out, /1 live gegaan/);
  const pending = JSON.parse(await fs.readFile(`${TMP}/data/pending.json`, 'utf8'));
  assert.equal(pending.length, 1, 'chain van de lijst gehaald terwijl de alert niet aankwam');
  assert.equal(pending[0].key, 'evm:8888');

  // Telegram werkt weer: de alert moet alsnog komen.
  const good = await tgServer();
  await watchTg(
    [chain(1, 'Ethereum'), { chainId: 8888, name: 'Hikchain', status: 'incubating', rpc: [node.url] }],
    good, probeOn
  );
  node.close();
  good.close();
  assert.equal(good.sent.length, 1, 'launch-alert niet hervat na herstel');
  assert.match(good.sent[0].text, /CHAIN IS LIVE[\s\S]*Hikchain/);
  const pending2 = JSON.parse(await fs.readFile(`${TMP}/data/pending.json`, 'utf8'));
  assert.equal(pending2.length, 0);
});

await t('P9: chain ID dat afwijkt van de aanvraag wordt gemeld, niet verzwegen', async () => {
  const text = formatChain({
    kind: 'launched', name: 'Mismatch Chain', source: 'ethlists-pr', url: 'https://x.test',
    chainId: 1, expectedChainId: 4242, chainIdMismatch: true, block: 21000000,
    liveRpc: 'https://rpc.mismatch.test', waitedDays: 3, score: 95, reasons: [],
  });
  assert.match(text, /RPC meldt chain ID/);
  assert.match(text, /4242/);
  assert.match(text, /3 dagen na detectie/);
});


// ---------------------------------------------------------------------------
// Commit-ruis en stilstanddetectie.
// ---------------------------------------------------------------------------

const { hourIso } = await import('../src/util.js');

await t('H1: uurstempel rondt naar beneden af en is stabiel binnen het uur', async () => {
  assert.equal(hourIso(new Date('2026-09-22T08:59:59.999Z')), '2026-09-22T08:00:00.000Z');
  assert.equal(hourIso(new Date('2026-09-22T08:00:00.000Z')), '2026-09-22T08:00:00.000Z');
  assert.notEqual(hourIso(new Date('2026-09-22T09:00:00.000Z')), hourIso(new Date('2026-09-22T08:00:00.000Z')));
});

await t('H2: pollen van de wachtlijst verandert pending.json niet elke run', async () => {
  await reset();
  const node = await rpcServer({ alive: false, flavor: 'evm', chainId: 4242, block: 1 });
  const tg = await tgServer();
  const probeOn = { PROBE_ENABLED: 'true' };

  await watchTg([chain(1, 'Ethereum')], tg, probeOn);
  const fixture = [chain(1, 'Ethereum'), { chainId: 4242, name: 'Wachtchain', status: 'incubating', rpc: [node.url] }];
  await watchTg(fixture, tg, probeOn);   // zet hem op de wachtlijst
  await watchTg(fixture, tg, probeOn);   // eerste poll: zet lastCheckedAt
  const a = await fs.readFile(`${TMP}/data/pending.json`, 'utf8');

  // Vanaf hier is er niets meer veranderd: de chain leeft nog niet. Twee
  // verdere runs binnen hetzelfde uur moeten het bestand byte-identiek laten.
  // Anders commit de workflow zichzelf suf — bij een poll elke 5 minuten zou
  // dat ~288 commits per dag zijn zonder dat er iets gebeurd is.
  await watchTg(fixture, tg, probeOn);
  await watchTg(fixture, tg, probeOn);
  node.close();
  tg.close();
  const b = await fs.readFile(`${TMP}/data/pending.json`, 'utf8');
  assert.equal(a, b, 'pending.json verandert bij elke run -> commit-ruis');
  assert.match(a, /"lastCheckedAt":"[^"]+T\d\d:00:00\.000Z"/, 'lastCheckedAt niet op het uur afgerond');
  assert.doesNotMatch(b, /"checks"/, 'teller die elke run oploopt hoort niet in de state');
});

await t('H3: hartslag wordt vastgelegd en blijft binnen het uur ongewijzigd', async () => {
  const beat = JSON.parse(await fs.readFile(`${TMP}/data/heartbeat.json`, 'utf8'));
  assert.equal(beat.lastRunAt, hourIso(), 'hartslag staat niet op het huidige uur');
});

await t('H4: een gat in de dekking levert een waarschuwing op', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);

  // Doe alsof de vorige run ruim zes uur geleden was.
  const zesUurGeleden = new Date(Date.now() - 6 * 3600 * 1000);
  await fs.writeFile(`${TMP}/data/heartbeat.json`, JSON.stringify({ lastRunAt: hourIso(zesUurGeleden) }));

  await watchTg([chain(1, 'Ethereum')], tg, { STALE_ALERT_HOURS: '3' });
  tg.close();
  const waarschuwing = tg.sent.find((m) => /stilgestaan/.test(m.text));
  assert.ok(waarschuwing, 'geen waarschuwing bij een gat van zes uur');
  assert.match(waarschuwing.text, /uur stilgestaan/);
  assert.match(waarschuwing.text, /workflow_dispatch/);
});

await t('H5: een normale cadans waarschuwt niet', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg([chain(1, 'Ethereum')], tg, { STALE_ALERT_HOURS: '3' });
  tg.close();
  assert.ok(!tg.sent.some((m) => /stilgestaan/.test(m.text)), 'vals alarm bij een normale run');
});

await t('A2: end-to-end — bronfout landt in de beheerderschat, niet in het kanaal', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg, { TELEGRAM_ADMIN_CHAT_ID: '4242' });
  await watchTg('BOOM', tg, { TELEGRAM_ADMIN_CHAT_ID: '4242' });
  tg.close();
  const storing = tg.sent.find((m) => /falen/.test(m.text));
  assert.ok(storing, 'bronfout niet gemeld');
  assert.equal(String(storing.chat_id), '4242', 'storing ging naar het kanaal i.p.v. de beheerder');
});

await t('A3: zonder beheerderschat blijft alles naar het gewone kanaal gaan', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg('BOOM', tg);
  tg.close();
  const storing = tg.sent.find((m) => /falen/.test(m.text));
  assert.ok(storing);
  assert.equal(String(storing.chat_id), '123', 'bestaand gedrag veranderd');
});


await t('P10: testnet dat mainnet gaat wordt als promotie gemeld en scoort hoger', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);

  // Eerst alleen een testnet.
  await watchTg([chain(1, 'Ethereum'), chain(900, 'Robinhood Chain Testnet')], tg);
  assert.match(tg.sent.at(-1).text, /NIEUWE TESTNET/);

  // Later gaat hetzelfde project mainnet.
  const out = await watchTg(
    [chain(1, 'Ethereum'), chain(900, 'Robinhood Chain Testnet'), chain(901, 'Robinhood Chain')], tg);
  tg.close();
  assert.match(out, /1 gedetecteerd, 1 alertwaardig/, 'promotie stil weggefilterd als duplicaat');
  const msg = tg.sent.at(-1).text;
  assert.match(msg, /NIEUWE MAINNET/);
  assert.match(msg, /Kenden we al als/, 'promotie niet benoemd in het bericht');
  assert.match(msg, /testnet/);
  assert.match(msg, /was al testnet/, 'promotie niet als reden meegegeven');
});

await t('P11: een wildvreemde mainnet is geen promotie', async () => {
  const { scoreChain } = await import('../src/score.js');
  const promo = scoreChain({ kind: 'mainnet', source: 'chainlist', promotedFrom: 'testnet' });
  const vreemd = scoreChain({ kind: 'mainnet', source: 'chainlist' });
  assert.ok(promo.score > vreemd.score, `${promo.score} moet boven ${vreemd.score} liggen`);
  assert.ok(promo.reasons.includes('was al testnet'));
  assert.equal(vreemd.reasons.length, 0);
});

await t('P12: testnet en mainnet in dezelfde run tellen niet als promotie', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  // Beide fasen komen tegelijk binnen: dan is er geen geschiedenis om naar
  // terug te wijzen, dus geen promotie.
  await watchTg([chain(1, 'Ethereum'), chain(910, 'Verschchain Testnet'), chain(911, 'Verschchain')], tg);
  tg.close();
  assert.ok(!tg.sent.some((m) => /Kenden we al als/.test(m.text)), 'valse promotie binnen dezelfde run');
});


// ---------------------------------------------------------------------------
// Stealth-detectie: chains die draaien zonder dat iemand het gezegd heeft.
// ---------------------------------------------------------------------------

const { hostsFromCrtSh } = await import('../src/sources/ct-hostnames.js');
const { unlabelledSubmitters } = await import('../src/sources/blob-submitters.js');
const { topicToAddress, hexToNum, endpointsFor } = await import('../src/evm.js');

await t('T1: crt.sh-parser pakt verse hostnamen en laat wildcards en oude certs liggen', async () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  const rows = [
    { entry_timestamp: '2026-09-21T10:00:00', name_value: 'rpc.mainnet.chain.robinhood.com' },
    { entry_timestamp: '2026-09-20T10:00:00', name_value: '*.mainnet.foo.com\nrpc.mainnet.foo.com' },
    { entry_timestamp: '2026-01-01T10:00:00', name_value: 'rpc.mainnet.oud.com' },
    { entry_timestamp: '2026-09-21T11:00:00', name_value: '' },
  ];
  const hosts = hostsFromCrtSh(rows, { maxAgeDays: 7, now });
  assert.ok(hosts.includes('rpc.mainnet.chain.robinhood.com'));
  assert.ok(hosts.includes('rpc.mainnet.foo.com'));
  assert.ok(!hosts.some((h) => h.startsWith('*')), 'wildcard-certificaat levert geen aanklopbaar adres');
  assert.ok(!hosts.includes('rpc.mainnet.oud.com'), 'cert van maanden geleden is geen nieuws');
});

await t('T2: crt.sh-parser overleeft rommel zonder te klappen', async () => {
  assert.deepEqual(hostsFromCrtSh(null), []);
  assert.deepEqual(hostsFromCrtSh([{}, { name_value: null }, 'kapot']), []);
});

await t('T3: blob-afzenders — alleen naamloze adressen die regelmatig posten', async () => {
  const txs = [
    { from: '0xAAA0000000000000000000000000000000000001', rollup: null, blockTimestamp: '2026-09-22T11:00:00.000Z', blockNumber: 10, hash: '0x1' },
    { from: '0xaaa0000000000000000000000000000000000001', rollup: null, blockTimestamp: '2026-09-22T11:05:00.000Z', blockNumber: 11, hash: '0x2' },
    { from: '0xAAA0000000000000000000000000000000000001', rollup: null, blockTimestamp: '2026-09-22T11:10:00.000Z', blockNumber: 12, hash: '0x3' },
    { from: '0xbbb0000000000000000000000000000000000002', rollup: 'base', blockTimestamp: '2026-09-22T11:06:00.000Z' },
    { from: '0xbbb0000000000000000000000000000000000002', rollup: 'base', blockTimestamp: '2026-09-22T11:07:00.000Z' },
    { from: '0xbbb0000000000000000000000000000000000002', rollup: 'base', blockTimestamp: '2026-09-22T11:08:00.000Z' },
    { from: '0xccc0000000000000000000000000000000000003', rollup: null, blockTimestamp: '2026-09-22T11:09:00.000Z' },
    { from: 'geen-adres', rollup: null },
  ];
  const found = unlabelledSubmitters(txs, { minTxs: 3 });
  assert.equal(found.length, 1, 'verwacht precies één naamloze regelmatige afzender');
  assert.equal(found[0].from, '0xaaa0000000000000000000000000000000000001', 'hoofdletters moeten samenvallen');
  assert.equal(found[0].count, 3);
  assert.equal(found[0].newest, '2026-09-22T11:10:00.000Z', 'nieuwste transactie niet bewaard');
  assert.equal(found[0].blockNumber, 12);
});

await t('T4: een afzender met een naam is geen vondst', async () => {
  const txs = Array.from({ length: 9 }, (_, i) => ({
    from: '0xddd0000000000000000000000000000000000004', rollup: 'arbitrum',
    blockTimestamp: `2026-09-22T11:0${i}:00.000Z`,
  }));
  assert.deepEqual(unlabelledSubmitters(txs, { minTxs: 3 }), []);
});

await t('T5: EVM-hulpjes decoderen topics en respecteren een eigen endpoint', async () => {
  assert.equal(
    topicToAddress('0x000000000000000000000000ebdc18a1000000000000000000000000000024b7'),
    '0xebdc18a1000000000000000000000000000024b7'
  );
  assert.equal(topicToAddress(undefined), null);
  assert.equal(topicToAddress('0x1234'), null);
  assert.equal(hexToNum('0x17cc'), 6092);
  assert.equal(hexToNum(undefined), null);

  const standaard = endpointsFor('ethereum');
  assert.ok(standaard.length > 1, 'meerdere endpoints nodig om uit te kunnen wijken');
  process.env.EVM_RPC_ETHEREUM = 'https://mijn-eigen.example/v2/sleutel';
  assert.deepEqual(endpointsFor('ethereum'), ['https://mijn-eigen.example/v2/sleutel']);
  delete process.env.EVM_RPC_ETHEREUM;
  assert.deepEqual(endpointsFor('onbekendeketen'), []);
});

await t('T6: een stealth-vondst komt door WATCH_KINDS heen', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg, { WATCH_KINDS: 'mainnet' });

  // WATCH_KINDS staat op alleen mainnet; een stealth-vondst hoort toch te komen,
  // want dat is precies waar de tool voor bestaat.
  await watchTg(
    [chain(1, 'Ethereum'),
     { chainId: 4663, name: 'Onaangekondigde chain 4663', kind: 'stealth', stealthKind: 'hostname' },
     chain(77, 'Zomaar Testnet')],
    tg, { WATCH_KINDS: 'mainnet' }
  );
  tg.close();
  const stealth = tg.sent.find((m) => /ONAANGEKONDIGDE CHAIN/.test(m.text));
  assert.ok(stealth, 'stealth-vondst weggefilterd door WATCH_KINDS');
  assert.match(stealth.text, /4663/);
  assert.ok(!tg.sent.some((m) => /Zomaar Testnet/.test(m.text)), 'WATCH_KINDS werkt niet meer voor gewone fasen');
});

await t('T7: stealth scoort boven alles wat via een register binnenkomt', async () => {
  const { scoreChain } = await import('../src/score.js');
  const stealth = scoreChain({ kind: 'stealth', stealthKind: 'hostname', source: 'ct-hostnames', chainId: 4663 });
  const aanvraag = scoreChain({ kind: 'proposal', source: 'ethlists-pr' });
  assert.ok(stealth.score > aanvraag.score, `${stealth.score} moet boven ${aanvraag.score} liggen`);
  assert.ok(stealth.reasons.some((r) => /nergens aangekondigd/.test(r)));
});


await t('T8: blokstand wordt grof bewaard zodat blocks.json niet elke run verandert', async () => {
  const { checkpoint } = await import('../src/sources/rollup-factory.js');
  // Binnen dezelfde duizend blokken blijft de bewaarde stand gelijk.
  assert.equal(checkpoint(21500123, 1000), 21500000);
  assert.equal(checkpoint(21500999, 1000), 21500000);
  assert.equal(checkpoint(21501000, 1000), 21501000, 'grens passeren moet de stand wel opschuiven');
  assert.equal(checkpoint(123, 20000), 0);
  assert.equal(checkpoint(NaN, 1000), 0);
  assert.equal(checkpoint(5000, 0), 0, 'grofheid nul mag niet tot een deling door nul leiden');
});


await t('T9: fabrieksgebeurtenis levert de sequencer-inbox en de overige contracten', async () => {
  const { addressWords } = await import('../src/evm.js');
  const addrs = [
    '0x1111111111111111111111111111111111111111', // inbox
    '0x2222222222222222222222222222222222222222', // outbox
    '0x3333333333333333333333333333333333333333', // rollupEventInbox
    '0x4444444444444444444444444444444444444444', // challengeManager
    '0x5555555555555555555555555555555555555555', // adminProxy
    '0x6666666666666666666666666666666666666666', // sequencerInbox
    '0x7777777777777777777777777777777777777777', // bridge
  ];
  const data = '0x' + addrs.map((a) => '0'.repeat(24) + a.slice(2)).join('');
  const words = addressWords(data);
  assert.equal(words.length, 7, 'oudere fabrieksversies hebben minder velden en dat mag');
  assert.equal(words[5], '0x6666666666666666666666666666666666666666', 'sequencer-inbox staat op plek 6');
  assert.equal(words[0], '0x1111111111111111111111111111111111111111');
});

await t('T10: rommel in het data-veld levert geen adressen maar ook geen uitzondering', async () => {
  const { addressWords } = await import('../src/evm.js');
  assert.deepEqual(addressWords(''), []);
  assert.deepEqual(addressWords(null), []);
  assert.deepEqual(addressWords('0x1234'), [], 'een half woord telt niet mee');
  // Een woord dat geen adres is (linkerhelft niet nul) wordt null, niet onzin.
  assert.deepEqual(addressWords('0x' + 'f'.repeat(64)), [null]);
});

await t('T11: bericht toont de sequencer-inbox en wie het uitgerold heeft', async () => {
  const { formatChain } = await import('../src/notify.js');
  const text = formatChain({
    kind: 'stealth', stealthKind: 'factory', source: 'rollup-factory',
    name: 'Nieuwe rollup (chain ID 4663)', chainId: 4663, url: 'https://etherscan.io/address/0xabc',
    contract: '0xabc0000000000000000000000000000000000001',
    sequencerInbox: '0x6666666666666666666666666666666666666666',
    deployer: '0xdead000000000000000000000000000000000001',
    score: 70, reasons: [],
  });
  assert.match(text, /Sequencer-inbox/);
  assert.match(text, /0x6666666666666666666666666666666666666666/);
  assert.match(text, /Uitgerold door/);
  assert.match(text, /0xdead000000000000000000000000000000000001/);
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
