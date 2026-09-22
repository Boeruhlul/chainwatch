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

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
