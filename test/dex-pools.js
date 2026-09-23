/**
 * Tests voor de dex-pools-bron, zonder netwerk: een lokale JSON-RPC-server
 * speelt de chain.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const TMP = 'test/.tmp-pools';
await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(`${TMP}/data`, { recursive: true });
process.env.CHAINWATCH_DATA = `${TMP}/data`;

const { PATTERNS, parsePoolLog, decodeSymbol, activeChains, default: source } =
  await import('../src/sources/dex-pools.js');
const { formatChain } = await import('../src/notify.js');
const { scoreChain } = await import('../src/score.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}
    ${e.message}`); fail++; }
}

// ---- Keccak-256, alleen voor de test (de tool zelf blijft zonder deps) ------
function keccak256(str) {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const R = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const M = (1n << 64n) - 1n;
  const rot = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
  const rate = 136;
  const msg = [...Buffer.from(str, 'utf8')];
  msg.push(0x01);
  while (msg.length % rate) msg.push(0);
  msg[msg.length - 1] |= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i] ^= v;
    }
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
      }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rot(s[x + y * 5], R[x + y * 5]);
      }
      for (let i = 0; i < 25; i++) s[i] = B[i] ^ (~B[(i % 5 + 1) % 5 + i - i % 5] & B[(i % 5 + 2) % 5 + i - i % 5] & M);
      s[0] ^= RC[round];
    }
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return `0x${out}`;
}

// ---- Hulpjes om logberichten te bouwen --------------------------------------
const word = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
const addrTopic = (a) => `0x${word(a)}`;
const T0 = '0x1111111111111111111111111111111111111111';
const T1 = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const topicOf = (sig) => PATTERNS.find((p) => p.sig === sig).topic;

await t('P1: topic-hashes zijn echt keccak256 van de signatuur', async () => {
  assert.equal(keccak256('batchCount()').slice(0, 10), '0x06f13056', 'keccak-implementatie zelf klopt niet');
  for (const p of PATTERNS) assert.equal(p.topic, keccak256(p.sig), `verkeerde hash voor ${p.sig}`);
});

await t('P2: v3 PoolCreated leest het pool-adres, niet de tickSpacing', async () => {
  // tickSpacing 60 ziet eruit als een adres met nullen ervoor: de klassieke valkuil.
  const r = parsePoolLog({
    address: '0xfac', topics: [topicOf('PoolCreated(address,address,uint24,int24,address)'), addrTopic(T0), addrTopic(T1), `0x${word('bb8')}`],
    data: `0x${word('3c')}${word(POOL)}`,
  });
  assert.equal(r.pool, POOL);
  assert.equal(r.fee, 3000);
  assert.equal(r.token0, T0);
});

await t('P3: v2 PairCreated, Solidly met en zonder geindexeerde stable', async () => {
  const v2 = parsePoolLog({
    topics: [topicOf('PairCreated(address,address,address,uint256)'), addrTopic(T0), addrTopic(T1)],
    data: `0x${word(POOL)}${word('7')}`,
  });
  assert.equal(v2.pool, POOL);
  const sig = 'PairCreated(address,address,bool,address,uint256)';
  const indexed = parsePoolLog({ topics: [topicOf(sig), addrTopic(T0), addrTopic(T1), `0x${word('1')}`], data: `0x${word(POOL)}${word('9')}` });
  const plain = parsePoolLog({ topics: [topicOf(sig), addrTopic(T0), addrTopic(T1)], data: `0x${word('1')}${word(POOL)}${word('9')}` });
  assert.equal(indexed.pool, POOL);
  assert.equal(plain.pool, POOL);
});

await t('P4: v4 Initialize geeft pool-ID, native ETH als nul-adres, en de hook', async () => {
  const id = `0x${'ab'.repeat(32)}`;
  const hook = '0x4444444444444444444444444444444444444444';
  const r = parsePoolLog({
    topics: [topicOf('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'), id, addrTopic('0x0'), addrTopic(T1)],
    data: `0x${word('bb8')}${word('3c')}${word(hook)}${word('1')}${word('0')}`,
  });
  assert.equal(r.poolId, id);
  assert.equal(r.pool, null);
  assert.equal(r.token0, '0x0000000000000000000000000000000000000000');
  assert.equal(r.hooks, hook);
  assert.equal(r.fee, 3000);
});

await t('P5: onbekend event of kapot log geeft null, geen verzonnen adres', async () => {
  assert.equal(parsePoolLog({ topics: ['0xdeadbeef'], data: '0x' }), null);
  assert.equal(parsePoolLog({ topics: [topicOf('PairCreated(address,address,address,uint256)')], data: '0x' }), null);
  assert.equal(parsePoolLog(null), null);
});

await t('P6: symbolen als string, als bytes32, en rommel', async () => {
  const str = (s) => {
    const hex = Buffer.from(s).toString('hex');
    return `0x${word('20')}${word(Buffer.from(s).length.toString(16))}${hex.padEnd(64, '0')}`;
  };
  assert.equal(decodeSymbol(str('PEPE')), 'PEPE');
  assert.equal(decodeSymbol(`0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}`), 'MKR');
  assert.equal(decodeSymbol('0x'), null);
  assert.equal(decodeSymbol('niet hex'), null);
  assert.equal(decodeSymbol(str(`A${String.fromCharCode(0)}B\nC`)), 'ABC', 'stuurtekens moeten eruit');
});

await t('P7: kwaadaardig tokensymbool wordt ge-escaped in het bericht', async () => {
  const c = {
    kind: 'pool', source: 'dex-pools', name: '<b>SCAM</b> / WETH op Robinhood Chain',
    ecosystem: 'Robinhood Chain', dex: 'Uniswap v2-fork', token0: T0, token1: T1,
    symbol0: '<a href="x">SCAM</a>', symbol1: 'WETH', pool: POOL, block: 5, fee: null,
  };
  Object.assign(c, scoreChain(c));
  const msg = formatChain(c);
  assert.ok(!msg.includes('<a href'), 'HTML uit een tokensymbool mag niet ongefilterd door');
  assert.ok(msg.includes('NIEUWE POOL'));
  assert.ok(msg.includes(POOL));
  assert.ok(c.score >= 38, 'een pool op een gekozen chain moet minstens een ster krijgen');
});

await t('P8: GIWA staat standaard uit, DEX_POOL_CHAINS zet hem aan', async () => {
  assert.ok(!activeChains({}).some((c) => c.key === 'giwa'));
  assert.deepEqual(activeChains({ DEX_POOL_CHAINS: 'giwa' }).map((c) => c.key), ['giwa']);
});

// ---- Fake chain ---------------------------------------------------------------
function rpcServer({ head, logsAt = {}, symbols = {} }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params });
      let result = null;
      if (method === 'eth_blockNumber') result = `0x${head.value.toString(16)}`;
      if (method === 'eth_getLogs') {
        const from = parseInt(params[0].fromBlock, 16);
        const to = parseInt(params[0].toBlock, 16);
        result = Object.entries(logsAt)
          .filter(([b]) => Number(b) >= from && Number(b) <= to)
          .map(([b, log]) => ({ ...log, blockNumber: `0x${Number(b).toString(16)}` }));
      }
      if (method === 'eth_call') result = symbols[params[0].to] || '0x';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

const v2log = (tx) => ({
  address: '0xfac0000000000000000000000000000000000000',
  topics: [topicOf('PairCreated(address,address,address,uint256)'), addrTopic(T0), addrTopic(T1)],
  data: `0x${word(POOL)}${word('1')}`, transactionHash: tx, logIndex: '0x0',
});

await t('P9: scant in stukken, bewaart een grove stand in een eigen bestand', async () => {
  const head = { value: 100000 };
  const srv = await rpcServer({
    head,
    logsAt: { 99000: v2log('0xaaa') },
    symbols: { [T0]: `0x${word('20')}${word('4')}${Buffer.from('PEPE').toString('hex').padEnd(64, '0')}` },
  });
  process.env.DEX_POOL_CHAINS = 'elysium';
  process.env.EVM_RPC_ELYSIUM = srv.url;
  try {
    const recs = await source.fetchAll();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].pool, POOL);
    assert.equal(recs[0].block, 99000);
    const blocks = JSON.parse(await fs.readFile(`${TMP}/data/pool-blocks.json`, 'utf8'));
    assert.equal(blocks.elysium % 500, 0, 'stand moet afgerond zijn op de grain');
    assert.ok(blocks.elysium <= 100000 && blocks.elysium > 99000);
    await assert.rejects(fs.readFile(`${TMP}/data/blocks.json`), 'mag blocks.json van rollup-factory niet aanraken');
    assert.ok(srv.calls.filter((c) => c.method === 'eth_getLogs').every((c) => !c.params[0].address),
      'geen adresfilter: ook onbekende fabrieken moeten gevonden worden');

    const [r] = await source.enrich(recs);
    assert.equal(r.symbol0, 'PEPE');
    assert.equal(r.symbol1, null);
    assert.ok(r.name.startsWith('PEPE / 0x222222'));

    // Twee runs zonder nieuwe blokken over de grens: bestand blijft byte-identiek.
    const before = await fs.readFile(`${TMP}/data/pool-blocks.json`, 'utf8');
    head.value = 100100;
    await source.fetchAll();
    assert.equal(await fs.readFile(`${TMP}/data/pool-blocks.json`, 'utf8'), before, 'commit-ruis');
  } finally {
    srv.close();
    delete process.env.DEX_POOL_CHAINS;
    delete process.env.EVM_RPC_ELYSIUM;
  }
});

await t('P10: grote achterstand springt vooruit in plaats van eeuwig in te halen', async () => {
  await fs.writeFile(`${TMP}/data/pool-blocks.json`, JSON.stringify({ elysium: 1000 }));
  const head = { value: 1000000 };
  const srv = await rpcServer({ head, logsAt: { 5000: v2log('0xoud'), 999900: v2log('0xnieuw') } });
  process.env.DEX_POOL_CHAINS = 'elysium';
  process.env.EVM_RPC_ELYSIUM = srv.url;
  try {
    const recs = await source.fetchAll();
    assert.deepEqual(recs.map((r) => r.key.split(':')[2]), ['0xnieuw']);
  } finally {
    srv.close();
    delete process.env.DEX_POOL_CHAINS;
    delete process.env.EVM_RPC_ELYSIUM;
  }
});

await t('P11: een onbereikbare chain laat de stand staan', async () => {
  await fs.writeFile(`${TMP}/data/pool-blocks.json`, JSON.stringify({ elysium: 4000 }));
  process.env.DEX_POOL_CHAINS = 'elysium';
  process.env.EVM_RPC_ELYSIUM = 'http://127.0.0.1:1';
  try {
    await assert.rejects(source.fetchAll(), /alle chains onbereikbaar/);
    const blocks = JSON.parse(await fs.readFile(`${TMP}/data/pool-blocks.json`, 'utf8'));
    assert.equal(blocks.elysium, 4000);
  } finally {
    delete process.env.DEX_POOL_CHAINS;
    delete process.env.EVM_RPC_ELYSIUM;
  }
});

// ---- Door de hele runner: pools vervuilen names.json en het dashboard niet ----
await t('P12: pool-alert gaat uit, maar komt niet in names.json of chains.json', async () => {
  const dir = `${TMP}/run`;
  await fs.mkdir(`${dir}/data`, { recursive: true });
  const fixture = `${dir}/fixture.json`;
  const env = {
    ...process.env, CHAINWATCH_DATA: `${dir}/data`, CHAINWATCH_DOCS: `${dir}/docs`,
    CHAINWATCH_FIXTURE: fixture, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    PROBE_ENABLED: 'false', WATCH_ENABLED: 'false',
  };
  const run = promisify(execFile);
  await fs.writeFile(fixture, JSON.stringify([{ chainId: 1, name: 'Bestaande Chain' }]));
  await run('node', ['src/index.js'], { env }); // bootstrap
  await fs.writeFile(fixture, JSON.stringify([
    { chainId: 1, name: 'Bestaande Chain' },
    { chainId: 777, name: 'PEPE / WETH op Robinhood Chain', kind: 'pool' },
  ]));
  const { stdout, stderr } = await run('node', ['src/index.js'], { env });
  const out = stdout + stderr;
  assert.ok(out.includes('NIEUWE POOL'), 'pool-alert moet uitgaan, ook buiten WATCH_KINDS');
  const names = JSON.parse(await fs.readFile(`${dir}/data/names.json`, 'utf8'));
  assert.ok(!names.some((n) => n.includes('pepe')), 'pool mag niet in names.json');
  const chains = JSON.parse(await fs.readFile(`${dir}/data/chains.json`, 'utf8'));
  assert.ok(!chains.some((c) => c.kind === 'pool'), 'pool mag niet in de dashboard-historie');
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald`);
if (fail) process.exit(1);
