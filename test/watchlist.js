/**
 * Watchlist: bekende projecten gericht volgen tot hun mainnet.
 * Alles lokaal: een nep-RPC, een nep-crt.sh en de fixture-bron.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TMP = 'test/.tmp-watch';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

/** Nep-RPC: het pad bepaalt welk chain ID er terugkomt. */
function rpcServer(routes) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const id = routes[req.url];
      if (id === undefined) { res.writeHead(404); return res.end(); }
      const { method } = JSON.parse(body || '{}');
      const result = method === 'eth_chainId' ? `0x${Number(id).toString(16)}` : '0x10';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** Nep-crt.sh: geeft terug wat er op dat moment in `rows` staat. */
function crtServer() {
  const state = { rows: [], calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.rows));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const cert = (name, daysAgo = 1) => ({
  name_value: name,
  entry_timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(),
});

console.log('\nwatchlist\n');

const { matchProject, matchRecord, classifyHost, runWatchlist } = await import('../src/watchlist.js');

await t('W1: namen matchen op heel woord of begin, niet op toevallige deelstrings', async () => {
  const P = [{ id: 'giwa' }, { id: 'arc' }, { id: 'ritual' }];
  assert.equal(matchProject('GIWA Mainnet', P)?.id, 'giwa');
  assert.equal(matchProject('giwaMainnet', P)?.id, 'giwa', 'camelCase uit viem');
  assert.equal(matchProject('Ritualchain', P)?.id, 'ritual', 'begin van de naam vanaf 5 tekens');
  assert.equal(matchProject('Arcadia', P), null, 'korte alias mag niet als voorvoegsel matchen');
  assert.equal(matchProject('Spiritual Chain', P), null);
});

await t('W2: een detectie met een RPC op het projectdomein hoort bij het project', async () => {
  const P = [{ id: 'giwa', domains: ['giwa.io'] }];
  assert.equal(matchRecord({ name: 'Add chain 12345', rpc: ['https://rpc.giwa.io'] }, P)?.id, 'giwa');
  assert.equal(matchRecord({ name: 'Iets', rpc: ['https://rpc.notgiwa.io'] }, P), null,
    'ander domein dat toevallig op giwa.io eindigt telt niet');
});

await t('W3: subdomeinen — productie-infra telt, test-infra niet', async () => {
  assert.equal(classifyHost('rpc.giwa.io'), 'interesting');
  assert.equal(classifyHost('mainnet-explorer.giwa.io'), 'interesting');
  assert.equal(classifyHost('rpc2.giwa.io'), 'interesting');
  assert.equal(classifyHost('swap.dachain.io'), 'interesting', 'een swap-subdomein is een DEX-signaal');
  assert.equal(classifyHost('dex.dachain.io'), 'interesting');
  assert.equal(classifyHost('swap-test.dachain.io'), null);
  assert.equal(classifyHost('sepolia-rpc.giwa.io'), null);
  assert.equal(classifyHost('dev-rpc.giwa.io'), null);
  assert.equal(classifyHost('www.giwa.io'), null);
  assert.equal(classifyHost('rpc.testchain.io', 'testchain.io'), 'interesting',
    'het projectdomein zelf mag niet als test-infra tellen');
});

await t('W4: RPC met bekend chain ID is stil, onbekend chain ID is een signaal — één keer', async () => {
  const rpc = await rpcServer({ '/testnet': 91342, '/mainnet': 424242 });
  try {
    const project = { id: 'giwa', name: 'GIWA', knownChainIds: [91342],
      rpc: [`${rpc.url}/testnet`, `${rpc.url}/mainnet`, `${rpc.url}/bestaatniet`] };
    const state = {};
    const r1 = await runWatchlist([project], state, { budgetMs: 5000 });
    assert.equal(r1.events.length, 1);
    assert.equal(r1.events[0].chainId, 424242);
    assert.equal(r1.events[0].kind, 'watch');
    assert.ok(r1.events[0].score >= 90);
    r1.commit(new Set());
    const r2 = await runWatchlist([project], state, { budgetMs: 5000 });
    assert.equal(r2.events.length, 0, 'zelfde chain mag niet elke run opnieuw alerten');
  } finally { rpc.close(); }
});

await t('W5: niet-afgeleverde RPC-alert komt de volgende run terug', async () => {
  const rpc = await rpcServer({ '/mainnet': 777 });
  try {
    const project = { id: 'x', rpc: [`${rpc.url}/mainnet`] };
    const state = {};
    const r1 = await runWatchlist([project], state, { budgetMs: 5000 });
    r1.commit(new Set([r1.events[0].key]));
    const r2 = await runWatchlist([project], state, { budgetMs: 5000 });
    assert.equal(r2.events.length, 1);
  } finally { rpc.close(); }
});

await t('W6: domein — eerste keer baseline, daarna alleen nieuwe productie-hostnamen', async () => {
  const crt = await crtServer();
  process.env.CT_BASE_URL = crt.url;
  try {
    const project = { id: 'giwa', name: 'GIWA', domains: ['giwa.test'] };
    const state = {};
    // Een oud certificaat (400 dagen) moet ook in de baseline: anders is zijn
    // vernieuwing later "nieuw".
    crt.state.rows = [cert('sepolia-rpc.giwa.test'), cert('rpc.giwa.test', 400)];
    const r1 = await runWatchlist([project], state, { budgetMs: 8000 });
    assert.equal(r1.events.length, 0, 'baseline mag niets melden');
    r1.commit(new Set());
    assert.deepEqual(state.giwa.hosts['giwa.test'].sort(), ['rpc.giwa.test', 'sepolia-rpc.giwa.test']);

    crt.state.rows = [
      cert('sepolia-rpc.giwa.test'), cert('rpc.giwa.test'), // vernieuwing, geen nieuws
      cert('mainnet-explorer.giwa.test'),                    // wel nieuws
      cert('dev-api.giwa.test'),                             // test-infra
      cert('rpc.anders.test'),                               // ander domein
    ];
    const r2 = await runWatchlist([project], state, { budgetMs: 15000 });
    assert.deepEqual(r2.events.map((e) => e.host), ['mainnet-explorer.giwa.test']);
    assert.equal(r2.events[0].watchKind, 'host');
    r2.commit(new Set());
    assert.ok(state.giwa.hosts['giwa.test'].includes('dev-api.giwa.test'), 'test-infra wordt stil vastgelegd');
    assert.ok(!state.giwa.hosts['giwa.test'].includes('rpc.anders.test'));

    const r3 = await runWatchlist([project], state, { budgetMs: 15000 });
    assert.equal(r3.events.length, 0);
  } finally { crt.close(); delete process.env.CT_BASE_URL; }
});

await t('W7: bootstrap legt vast zonder te melden', async () => {
  const rpc = await rpcServer({ '/m': 5 });
  try {
    const state = {};
    const r = await runWatchlist([{ id: 'y', rpc: [`${rpc.url}/m`] }], state, { budgetMs: 5000, baselineOnly: true });
    assert.equal(r.events.length, 0);
    r.commit(new Set());
    const again = await runWatchlist([{ id: 'y', rpc: [`${rpc.url}/m`] }], state, { budgetMs: 5000 });
    assert.equal(again.events.length, 0, 'wat er bij de bootstrap al draaide is geen nieuws');
  } finally { rpc.close(); }
});

await t('W8: bericht toont het watchlist-label en de werkende RPC', async () => {
  const { formatChain } = await import('../src/notify.js');
  const text = formatChain({
    kind: 'watch', watchKind: 'rpc', name: 'GIWA — nieuwe chain ID 91341', chainId: 91341,
    source: 'watchlist', url: 'https://giwa.io', liveRpc: 'https://rpc.giwa.io', block: 12,
    via: 'kandidaat-RPC', score: 97, reasons: ['watchlist'], watch: { id: 'giwa', name: 'GIWA' },
  });
  assert.match(text, /WATCHLIST/);
  assert.match(text, /rpc\.giwa\.io/);
  assert.match(text, /blok 12/);
});

// ---- End-to-end via de echte runner ---------------------------------------

async function reset() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(`${TMP}/data`, { recursive: true });
}

async function watch(fixture, watchlist) {
  await fs.writeFile(`${TMP}/fixture.json`, JSON.stringify(fixture));
  if (watchlist) await fs.writeFile(`${TMP}/data/watchlist.json`, JSON.stringify({ projects: watchlist }));
  const { stdout, stderr } = await run('node', ['src/index.js'], {
    env: {
      ...process.env,
      CHAINWATCH_DATA: `${TMP}/data`, CHAINWATCH_DOCS: `${TMP}/docs`,
      CHAINWATCH_FIXTURE: `${TMP}/fixture.json`,
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', PROBE_ENABLED: 'false',
    },
  });
  return stdout + stderr;
}

const chain = (id, name, extra = {}) => ({ chainId: id, name, rpc: [`https://rpc.${id}.test`], ...extra });
// Geen rpc en geen domeinen: de end-to-end tests doen zo geen netwerkverkeer.
const WL = [{ id: 'giwa', name: 'GIWA', aliases: ['giwa'] }];

await t('W9: bekende naam in een nieuwe bron komt door als watchlist-project — maar één keer', async () => {
  await reset();
  await watch([chain(1, 'Ethereum'), chain(91342, 'GIWA', { status: 'incubating' })], WL);

  // Zelfde project, zelfde fase, nieuwe chain-key: normaal een stille cross-listing.
  const out1 = await watch([chain(1, 'Ethereum'), chain(91342, 'GIWA', { status: 'incubating' }),
                            chain(4242, 'Giwa', { status: 'incubating' })], WL);
  assert.match(out1, /Op je watchlist: GIWA/);
  assert.match(out1, /1 alertwaardig/);

  // Nog een register met hetzelfde: geen tweede bericht.
  const out2 = await watch([chain(1, 'Ethereum'), chain(91342, 'GIWA', { status: 'incubating' }),
                            chain(4242, 'Giwa', { status: 'incubating' }),
                            chain(4243, 'GIWA', { status: 'incubating' })], WL);
  assert.match(out2, /0 alertwaardig/);
});

await t('W10: gewone mainnet van een watchlist-project wordt gelabeld en telt als gemeld', async () => {
  const out = await watch([chain(1, 'Ethereum'), chain(91342, 'GIWA', { status: 'incubating' }),
                           chain(4242, 'Giwa', { status: 'incubating' }), chain(4243, 'GIWA', { status: 'incubating' }),
                           chain(5000, 'GIWA Mainnet')], WL);
  assert.match(out, /NIEUWE MAINNET[\s\S]*Op je watchlist: GIWA/);
  const st = JSON.parse(await fs.readFile(`${TMP}/data/watch-state.json`, 'utf8'));
  assert.ok(st.giwa.bypassed.includes('giwa:main'));
});

await t('W11: watchlist-testnets blijven gewoon onder de normale regels', async () => {
  const out = await watch([chain(1, 'Ethereum'), chain(91342, 'GIWA', { status: 'incubating' }),
                           chain(4242, 'Giwa', { status: 'incubating' }), chain(4243, 'GIWA', { status: 'incubating' }),
                           chain(5000, 'GIWA Mainnet'), chain(91343, 'GIWA Testnet 2')], WL);
  assert.doesNotMatch(out, /Op je watchlist[\s\S]*Testnet 2/);
});

await t('W12: kapotte watchlist laat de run hard falen in plaats van stil verder te gaan', async () => {
  await fs.writeFile(`${TMP}/data/watchlist.json`, '{ kapot');
  await assert.rejects(watch([chain(1, 'Ethereum')]), /corrupt/);
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
