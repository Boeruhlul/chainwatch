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
      ...env,
    },
  });
  return stdout + stderr;
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
        TELEGRAM_BOT_TOKEN: 'testtoken', TELEGRAM_CHAT_ID: '123', ...env,
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

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
