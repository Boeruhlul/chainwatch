/**
 * Tests voor de discovery-laag: dossiers, ecosysteem-scan, nieuwe bronnen,
 * onderzoeksinname en het dagoverzicht. Geen netwerk: een lokale JSON-RPC-
 * server speelt de chain, een lokale Telegram-server vangt de berichten.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { keccak256 } from './keccak.js';

const run = promisify(execFile);
const TMP = 'test/.tmp-discovery';
await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(`${TMP}/data`, { recursive: true });
process.env.CHAINWATCH_DATA = `${TMP}/data`;

const D = await import('../src/dossiers.js');
const { analyze, scanEcosystems, applyFindings, _test: E } = await import('../src/ecosystem.js');
const { PATTERNS } = await import('../src/pools.js');
const { formatEvent, researchMessages, buildDigest, digestDue, amsterdamNow } = await import('../src/briefing.js');
const gd = await import('../src/sources/github-discovery.js');
const fr = await import('../src/sources/funding-rss.js');
const { normalizeCandidate } = await import('../src/sources/research.js');
const { limits } = await import('../src/notify.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const rec = (o) => ({ rpc: [], explorers: [], faucets: [], detectedAt: '2026-10-01T10:00:00Z', ...o });

console.log('\ndiscovery tests\n');

// ---- Dossiers ----------------------------------------------------------------

await t('D1: aanvraag en latere registratie met hetzelfde chain ID vormen één dossier', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'ethpr:1', source: 'ethlists-pr', kind: 'proposal', name: 'Zork Testnet', chainId: 777123, url: 'u1' })], { quiet: true });
  D.ingest(db, [rec({ key: 'evm:777123', source: 'chainlist', kind: 'testnet', name: 'ZorkNet Sepolia', chainId: 777123, url: 'u2', detectedAt: '2026-10-05T10:00:00Z' })]);
  const all = Object.values(db.dossiers);
  assert.equal(all.length, 1);
  assert.equal(all[0].stage, 'testnet');
  assert.equal(all[0].confidence, 'A', 'register-testnet is een draaiend netwerk');
  assert.equal(all[0].firstSeen, '2026-10-01');
  assert.ok(all[0].aliases.includes('ZorkNet Sepolia'));
});

await t('D2: twee bekende dossiers die een sleutel blijken te delen worden gekoppeld en gemeld', async () => {
  const db = D.emptyDb();
  D.ingest(db, [
    rec({ key: 'ct:rpc.mainnet.quasar.xyz', source: 'ct-hostnames', kind: 'stealth', stealthKind: 'hostname', name: 'Onbekend 990001', chainId: 990001, url: 'a' }),
    rec({ key: 'news:x', source: 'funding-rss', kind: 'lead', name: 'Quasar Labs', website: 'https://quasar.xyz', url: 'b' }),
  ], { quiet: true });
  assert.equal(Object.keys(db.dossiers).length, 2);
  const ev = D.ingest(db, [rec({ key: 'ethpr:9', source: 'ethlists-pr', kind: 'proposal', name: 'Quasar', chainId: 990001, website: 'https://quasar.xyz', url: 'c', detectedAt: '2026-10-08T10:00:00Z' })]);
  assert.equal(Object.keys(db.dossiers).length, 1, 'samengevoegd');
  const link = ev.find((e) => e.type === 'link');
  assert.ok(link, 'koppeling gemeld');
  const text = formatEvent(db, link);
  assert.match(text, /GEKOPPELD/);
  assert.ok(text.length < limits.SAFE_LEN);
});

await t('D3: correlatie zonder eigen alert geeft een opwaardering-melding', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'news:1', source: 'funding-rss', kind: 'lead', name: 'Velaro', url: 'n' })], { quiet: true });
  assert.equal(Object.values(db.dossiers)[0].confidence, 'D');
  const ev = D.ingest(db, [rec({ key: 'ghrepo:velaro/node', source: 'github-discovery', kind: 'lead', name: 'velaro-labs/node', noNameKey: true, githubOrg: 'velaro-labs', website: 'https://velaro.io', url: 'g' })]);
  // Andere naam, geen gedeelde sleutel: nog geen verband.
  assert.equal(ev.length, 0);
  const ev2 = D.ingest(db, [rec({ key: 'ghrepo:velaro/genesis', source: 'github-discovery', kind: 'lead', name: 'Velaro', githubOrg: 'velaro-labs', url: 'g2' })]);
  const up = ev2.find((e) => e.type === 'upgrade' || e.type === 'link');
  assert.ok(up, 'verband gemeld');
  const d = Object.values(db.dossiers).find((x) => x.keys.includes('n:velaro'));
  assert.equal(d.confidence, 'B');
});

await t('D4: wat zelf al als alert uitgaat krijgt geen tweede melding', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'news:2', source: 'funding-rss', kind: 'lead', name: 'Kestrel', url: 'n' })], { quiet: true });
  const r = rec({ key: 'evm:4242', source: 'chainlist', kind: 'mainnet', name: 'Kestrel', chainId: 4242, url: 'c' });
  const ev = D.ingest(db, [r], { alertKeys: new Set(['evm:4242']) });
  assert.equal(ev.length, 0);
  const ctx = D.contextFor(db, r);
  assert.equal(ctx.confidence, 'A');
  assert.equal(ctx.earlier.length, 1, 'eerder bewijs zichtbaar in de alert');
});

await t('D5: generieke namen knopen geen projecten aan elkaar', async () => {
  const db = D.emptyDb();
  D.ingest(db, [
    rec({ key: 'a', source: 'l2beat', kind: 'upcoming', name: 'Testnet', url: '1' }),
    rec({ key: 'b', source: 'l2beat', kind: 'upcoming', name: 'testnet', url: '2' }),
    rec({ key: 'c', source: 'github-discovery', kind: 'lead', name: 'acme/genesis', noNameKey: true, githubOrg: 'acme', url: '3' }),
    rec({ key: 'd', source: 'github-discovery', kind: 'lead', name: 'other/genesis', noNameKey: true, githubOrg: 'other', url: '4' }),
  ], { quiet: true });
  const n = Object.keys(db.dossiers).length;
  assert.equal(n, 2, `alleen de twee GitHub-orgs krijgen een dossier (kreeg ${n})`);
});

await t('D5b: hosting- en stackplatforms knopen geen projecten aan elkaar', async () => {
  const db = D.emptyDb();
  D.ingest(db, [
    rec({ key: 'a', source: 'ethlists-pr', kind: 'proposal', name: 'Eerste', chainId: 7100001, website: 'https://foo.workers.dev', socials: { github: 'https://github.com/matter-labs' }, url: '1' }),
    rec({ key: 'b', source: 'ethlists-pr', kind: 'proposal', name: 'Tweede', chainId: 7100002, website: 'https://bar.workers.dev', socials: { github: 'https://github.com/matter-labs' }, url: '2' }),
  ], { quiet: true });
  assert.equal(Object.keys(db.dossiers).length, 2);
  db.dossiers.eerste.keys.push('gh:cloudflare');
  D.ingest(db, [], { quiet: true });
  assert.ok(!db.dossiers.eerste.keys.includes('gh:cloudflare'), 'oude platformsleutel opgeruimd');
});

await t('S1: nep-chain met de naam van een bekend project maar een ander domein vervuilt het echte dossier niet', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'g1', source: 'chainlist', kind: 'testnet', name: 'GIWA Sepolia', chainId: 91342, website: 'https://giwa.io', rpc: ['https://sepolia-rpc.giwa.io'], url: 'g' })], { quiet: true });
  const fake = rec({ key: 'g2', source: 'ethlists-pr', kind: 'launched', name: 'GIWA', chainId: 9134, rpc: ['https://rpc.giwa-mainnet.xyz'], liveRpc: 'https://rpc.giwa-mainnet.xyz', url: 'f', detectedAt: '2026-10-05T10:00:00Z' });
  D.ingest(db, [fake]);
  const real = Object.values(db.dossiers).find((x) => x.keys.includes('d:giwa.io'));
  assert.ok(!real.evidence.some((e) => e.url === 'f'), 'nep-bewijs niet in het echte dossier');
  assert.equal(fake.suspect?.type, 'imitatie');
  const sus = db.dossiers[fake.dossierId];
  assert.ok(sus.suspect, 'apart dossier gemarkeerd');
  assert.equal(sus.confidence, 'C', 'ook al antwoordt de RPC: nooit A');
  // Een latere echte GIWA-detectie belandt gewoon in het echte dossier.
  const legit = rec({ key: 'g3', source: 'chainlist', kind: 'mainnet', name: 'GIWA', chainId: 91341, website: 'https://giwa.io', url: 'r', detectedAt: '2026-11-01T10:00:00Z' });
  D.ingest(db, [legit]);
  assert.equal(legit.dossierId, real.id);
});

await t('S2: chain ID van een ander project met een ander domein is een botsing, geen koppeling', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'p', source: 'ethlists-commit', kind: 'mainnet', name: 'PXA Chain', chainId: 784, website: 'https://pxachain.com', url: 'p' })], { quiet: true });
  const w = rec({ key: 'w', source: 'watchlist', kind: 'watch', watchKind: 'rpc', name: 'Ritual — nieuwe chain ID 784', watch: { name: 'Ritual' }, chainId: 784, website: 'https://ritual.net', liveRpc: 'https://rpc.ritualfoundation.org', url: 'w' });
  const ev = D.ingest(db, [w]);
  assert.equal(Object.keys(db.dossiers).length, 2);
  assert.equal(w.suspect?.type, 'id-botsing');
  assert.equal(ev.filter((e) => e.type === 'link').length, 0);
});

await t('S3: codenaam zonder eigen domein koppelt nog steeds via chain ID', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'a', source: 'ct-hostnames', kind: 'stealth', stealthKind: 'hostname', name: 'Onbekend', chainId: 770077, url: 'a' })], { quiet: true });
  const r = rec({ key: 'b', source: 'chainlist', kind: 'mainnet', name: 'Echte Naam', chainId: 770077, website: 'https://echtenaam.io', url: 'b' });
  D.ingest(db, [r]);
  assert.equal(Object.keys(db.dossiers).length, 1);
  assert.ok(!r.suspect);
});

await t('D6: intensief tot mainnet + 14 dagen, daarna gewone monitoring', async () => {
  const d = { stage: 'mainnet', mainnetSince: '2026-10-01', lastActivity: '2026-10-01' };
  assert.equal(D.isIntensive(d, '2026-10-10'), true);
  assert.equal(D.isIntensive(d, '2026-10-20'), false);
  assert.equal(D.isIntensive({ stage: 'testnet', lastActivity: '2026-09-01' }, '2026-10-01'), true);
  assert.equal(D.isIntensive({ stage: 'lead', lastActivity: '2026-10-01' }, '2026-10-01'), false);
});

await t('D7: dossierbestand is byte-identiek als er niets bijkomt (geen commit-ruis)', async () => {
  const db = D.emptyDb();
  const r = rec({ key: 'evm:5', source: 'chainlist', kind: 'testnet', name: 'Ruisloos Testnet', chainId: 5555551, url: 'x' });
  D.ingest(db, [r], { quiet: true });
  const f = `${TMP}/d7.json`;
  await D.saveDossiers(db, f);
  const a = await fs.readFile(f, 'utf8');
  const db2 = await D.loadDossiers(f);
  D.ingest(db2, [{ ...r, detectedAt: '2026-10-01T23:59:00Z' }]);
  await D.saveDossiers(db2, f);
  assert.equal(await fs.readFile(f, 'utf8'), a);
});

await t('D8: corrupt dossierbestand faalt hard', async () => {
  const f = `${TMP}/d8.json`;
  await fs.writeFile(f, '{ kapot');
  await assert.rejects(() => D.loadDossiers(f), /corrupt/);
  assert.equal(await D.loadDossiers(`${TMP}/bestaat-niet.json`), null);
});

// ---- Ecosysteem ----------------------------------------------------------------

const word = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
const topicAddr = (a) => `0x${word(a)}`;
const FACTORY = '0xfac0000000000000000000000000000000000001';
const PAD = '0xbad0000000000000000000000000000000000002';
const USER = '0x0000000000000000000000000000000000000abc';
const tok = (i) => `0x70${String(i).padStart(38, '0')}`;
const POOL = '0x9999999999999999999999999999999999999999';
const V2 = PATTERNS.find((p) => p.sig === 'PairCreated(address,address,address,uint256)').topic;
const mint = (token, to, n = 3) => ({ address: token, topics: [E.TRANSFER, E.ZERO_TOPIC, topicAddr(to)].slice(0, n), data: `0x${word('64')}` });

await t('E1: topic-hashes van DEX-patronen en Transfer zijn echt keccak256', async () => {
  assert.equal(keccak256('Transfer(address,address,uint256)'), E.TRANSFER);
  for (const p of PATTERNS) assert.equal(p.topic, keccak256(p.sig), p.sig);
});

await t('E2: fabriek = DEX, contract met de beginvoorraad van 3+ tokens = launchpad', async () => {
  const pools = [{ address: FACTORY, topics: [V2, topicAddr(tok(1)), topicAddr(tok(2))], data: `0x${word(POOL)}${word('1')}` }];
  const mints = [
    mint(tok(1), PAD), mint(tok(2), PAD), mint(tok(3), PAD),
    mint(tok(4), USER),                          // gewoon token voor een gebruiker
    mint(POOL, PAD),                             // LP-token van een pool telt niet
    { ...mint(tok(5), PAD), topics: [E.TRANSFER, E.ZERO_TOPIC, topicAddr(PAD), `0x${word('1')}`] }, // NFT
    mint(tok(6), '0x000000000000000000000000000000000000dead'),
  ];
  const a = analyze(pools, mints);
  assert.equal(a.dex.length, 1);
  assert.equal(a.dex[0].addr, FACTORY);
  assert.equal(a.launchpad.length, 1);
  assert.equal(a.launchpad[0].addr, PAD);
  assert.equal(a.launchpad[0].tokens, 3);
});

await t('E3: twee tokens is nog geen launchpad', async () => {
  const a = analyze([], [mint(tok(1), PAD), mint(tok(2), PAD)]);
  assert.equal(a.launchpad.length, 0);
});

/** Lokale chain: antwoordt op chainId, blockNumber, getLogs en getCode. */
function chainServer({ poolLogs = [], mintLogs = [], codeAt = new Set() } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      calls.push(method);
      let result = null;
      if (method === 'eth_chainId') result = '0x1e240';
      else if (method === 'eth_blockNumber') result = '0x186a0';
      else if (method === 'eth_getLogs') {
        const t0 = params[0].topics[0];
        result = Array.isArray(t0) ? poolLogs : mintLogs;
      } else if (method === 'eth_getCode') result = codeAt.has(params[0]) ? '0x6080' : '0x';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

await t('E4: end-to-end scan meldt de eerste DEX en launchpad één keer', async () => {
  const srv = await chainServer({
    poolLogs: [{ address: FACTORY, topics: [V2, topicAddr(tok(1)), topicAddr(tok(2))], data: `0x${word(POOL)}${word('1')}` }],
    mintLogs: [mint(tok(1), PAD), mint(tok(2), PAD), mint(tok(3), PAD), mint(tok(7), USER), mint(tok(8), USER), mint(tok(9), USER)],
    codeAt: new Set([PAD]),
  });
  try {
    const db = D.emptyDb();
    const today = new Date().toISOString();
    D.ingest(db, [rec({ key: 'l', source: 'ethlists-pr', kind: 'launched', name: 'Nova Chain', chainId: 123456, liveRpc: srv.url, url: 'x', detectedAt: today })], { quiet: true });
    db.dossiers[Object.keys(db.dossiers)[0]].explorer = 'https://explorer.nova.test';
    const s1 = await scanEcosystems(db, { limit: 5, budgetMs: 10000 });
    assert.equal(s1.candidates, 1);
    const ev = applyFindings(db, s1.findings);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].launchpad.length, 1, 'gebruiker (EOA) met 3 tokens is geen launchpad');
    const text = formatEvent(db, ev[0]);
    assert.match(text, /EERSTE DEX \+ LAUNCHPAD OP NOVA CHAIN/);
    assert.match(text, /explorer\.nova\.test\/address\/0xbad/);
    assert.ok(text.length < limits.SAFE_LEN);
    const s2 = await scanEcosystems(db, { limit: 5, budgetMs: 10000 });
    assert.equal(applyFindings(db, s2.findings).length, 0, 'al bekende fabriek meldt niet opnieuw');
  } finally {
    srv.close();
  }
});

// ---- Nieuwe bronnen ----------------------------------------------------------

await t('G1: GitHub-discovery herkent chainconfigs en negeert tests en tutorials', async () => {
  const hits = gd.configHits(['README.md', 'op/rollup.json', 'deploy-config/mainnet.json', 'test/genesis.json', 'node_modules/x/genesis.json', 'config/genesis.json']);
  assert.deepEqual(hits.map((h) => h.path), ['op/rollup.json', 'deploy-config/mainnet.json', 'config/genesis.json']);
  assert.equal(gd.isJunk({ name: 'op-stack-tutorial', description: '' }), true);
  assert.equal(gd.isJunk({ name: 'zork-chain', description: 'node configs for zork mainnet' }), false);
  for (const q of gd.QUERIES) assert.ok(q.length < 200);
});

await t('G1b: onbekende netwerknamen uit omschrijvingen, bekende niet', async () => {
  assert.deepEqual(gd.mentionedNetworks('Testnet GPU mining infrastructure on Robinhood Chain'), []);
  assert.deepEqual(gd.mentionedNetworks('Community HUD for Tau Testnet Alpha'), ['Tau']);
  assert.deepEqual(gd.mentionedNetworks('TypeScript examples for Tidepool testnet API'), []); // kleine t: te vaag
  assert.deepEqual(gd.mentionedNetworks('Bridge for Stellar Testnet and Nexora Chain Mainnet'), ['Nexora Chain']);
});

await t('G2: GitHub-discovery draait één keer per uur', async () => {
  assert.equal(gd.inSlot(new Date('2026-10-28T09:03:00Z')), true);
  assert.equal(gd.inSlot(new Date('2026-10-28T09:33:00Z')), false);
});

await t('G3: funding-RSS haalt projectnamen uit financieringstitels, rest valt weg', async () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Zenith Labs raises $25M to build a new Layer 1 for payments]]></title><link>https://n.example/a</link></item>
    <item><title>Bitcoin price hits new high</title><link>https://n.example/b</link></item>
    <item><title>Acme raises $5M for its NFT marketplace</title><link>https://n.example/c</link><description>a marketplace</description></item>
    <item><title>&#8216;Orbitron&#8217; secures $8 million seed round for rollup infrastructure</title><link>https://n.example/d</link></item>
  </channel></rss>`;
  const items = fr.parseFeed(xml);
  assert.equal(items.length, 4);
  const names = items.map(fr.fundingLead).filter(Boolean);
  assert.deepEqual(names, ['Zenith Labs', 'Orbitron']);
});

await t('G4: onderzoekskandidaten worden genormaliseerd, rommel valt weg', async () => {
  assert.equal(normalizeCandidate({ name: '' }, 'f.json'), null);
  const r = normalizeCandidate({
    name: 'BNB New L1', confidence: 'Z', stage: 'whatever', website: 'javascript:alert(1)',
    facts: [{ claim: 'Team posted a job ad', url: 'https://jobs.example/1', date: '2026-10-01' }, { claim: '' }],
    hypotheses: ['Might be Move-based'], chainIds: [null, 5611],
  }, '2026-10-28-initial.json');
  assert.equal(r.research.confidence, 'D', 'onbekend oordeel wordt D, niet hoger');
  assert.equal(r.research.stage, 'rumor');
  assert.equal(r.website, null);
  assert.equal(r.research.facts.length, 1);
  assert.deepEqual(r.research.chainIds, ['5611']);
  assert.equal(r.kind, 'research');
});

await t('G5: onderzoeksbericht blijft binnen de Telegram-limiet en zet A bovenaan', async () => {
  const db = D.emptyDb();
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push({ ...normalizeCandidate({ name: `Kandidaat ${i}`, confidence: i === 30 ? 'A' : 'C', why: 'x'.repeat(300), facts: [{ claim: 'c', url: `https://e.example/${i}` }] }, 'w.json'), detectedAt: new Date().toISOString() });
  }
  D.ingest(db, recs, { quiet: true });
  const msgs = researchMessages(db, recs);
  assert.ok(msgs.length >= 2);
  for (const m of msgs) assert.ok(m.length <= limits.SAFE_LEN, `te lang: ${m.length}`);
  assert.match(msgs[0], /<b>A · Kandidaat 30<\/b>/);
});

// ---- Dagoverzicht --------------------------------------------------------------

await t('B1: dagoverzicht zegt het eerlijk als er niets gebeurde', async () => {
  const text = buildDigest(D.emptyDb(), { since: '2026-10-27', today: '2026-10-28' });
  assert.match(text, /Geen nieuwe ontdekkingen/);
});

await t('B2: dagoverzicht één keer per dag, na het ingestelde uur in Amsterdam', async () => {
  const at = new Date('2026-10-28T08:30:00Z'); // 09:30 in Amsterdam (CET)
  assert.equal(amsterdamNow(at).hour, 9);
  assert.ok(digestDue({ digest: {} }, { hour: 8, now: at }));
  assert.equal(digestDue({ digest: { lastSent: '2026-10-28' } }, { hour: 8, now: at }), null);
  assert.equal(digestDue({ digest: {} }, { hour: 10, now: at }), null);
});

await t('B3: dagoverzicht toont nieuwe A/B, statuswijzigingen en zwakke leads apart', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'old', source: 'ethlists-pr', kind: 'proposal', name: 'Oudje', chainId: 31337001, url: 'o', detectedAt: '2026-09-01T10:00:00Z' })], { quiet: true });
  D.ingest(db, [
    rec({ key: 'old2', source: 'chainlist', kind: 'mainnet', name: 'Oudje', chainId: 31337001, url: 'o2', detectedAt: '2026-10-28T06:00:00Z' }),
    rec({ key: 'n1', source: 'chainlist', kind: 'testnet', name: 'Nieuweling Testnet', chainId: 31337002, url: 'n', detectedAt: '2026-10-28T06:00:00Z' }),
    rec({ key: 'l1', source: 'funding-rss', kind: 'lead', name: 'Gerucht', url: 'g', detectedAt: '2026-10-28T06:00:00Z' }),
  ], { quiet: true });
  const text = buildDigest(db, { since: '2026-10-28', today: '2026-10-28', weekly: true });
  assert.match(text, /Nieuwe netwerken \(A\/B\): 1/);
  assert.match(text, /Dichter bij lancering: 1/);
  assert.match(text, /Oudje → mainnet/);
  assert.match(text, /Gerucht/);
  assert.match(text, /Week/);
  assert.ok(text.length <= limits.SAFE_LEN);
});

// ---- End-to-end door de echte runner ------------------------------------------

function tgServer() {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { sent.push(JSON.parse(body)); } catch { /* */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function runner(fixture, tg, env = {}) {
  const dir = `${TMP}/e2e`;
  await fs.writeFile(`${dir}/fixture.json`, JSON.stringify(fixture));
  return run('node', ['src/index.js'], {
    env: {
      ...process.env,
      CHAINWATCH_DATA: `${dir}/data`, CHAINWATCH_DOCS: `${dir}/docs`, CHAINWATCH_FIXTURE: `${dir}/fixture.json`,
      TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', CHAINWATCH_TG_API: tg.url,
      PROBE_ENABLED: 'false', WATCH_ENABLED: 'false', ENRICH_SOCIALS: 'false', ECO_ENABLED: 'false', RADAR_ENABLED: 'false',
      ...env,
    },
  });
}

await t('X1: runner bouwt dossiers op, geeft context mee en stuurt het dagoverzicht één keer', async () => {
  await fs.rm(`${TMP}/e2e`, { recursive: true, force: true });
  await fs.mkdir(`${TMP}/e2e/data`, { recursive: true });
  const tg = await tgServer();
  try {
    const base = [{ chainId: 900001, name: 'Alpha Chain' }];
    await runner(base, tg, { DIGEST_ENABLED: 'false' }); // bootstrap
    const db0 = JSON.parse(await fs.readFile(`${TMP}/e2e/data/dossiers.json`, 'utf8'));
    assert.ok(db0.dossiers, 'dossiers.json geschreven');
    await runner([...base, { chainId: 900002, name: 'Bravo Testnet', faucets: ['https://f'] }], tg, { DIGEST_ENABLED: 'false' });
    const alert = tg.sent.find((m) => /Bravo/.test(m.text));
    assert.ok(alert, 'gewone alert verstuurd');
    assert.match(alert.text, /📁 <b>Confidence [A-D]<\/b>/);
    const before = tg.sent.length;
    await runner([...base, { chainId: 900002, name: 'Bravo Testnet', faucets: ['https://f'] }], tg, { DIGEST_ENABLED: 'true', DIGEST_HOUR: '0' });
    assert.equal(tg.sent.length, before + 1, 'precies één dagoverzicht');
    assert.match(tg.sent.at(-1).text, /dagoverzicht/);
    await runner([...base, { chainId: 900002, name: 'Bravo Testnet', faucets: ['https://f'] }], tg, { DIGEST_ENABLED: 'true', DIGEST_HOUR: '0' });
    assert.equal(tg.sent.length, before + 1, 'niet nog eens dezelfde dag');
  } finally {
    tg.close();
  }
});

const { buildBlocklist } = await import('../src/blocklist.js');

await t('K1: blocklist herkent op naam, chain ID, domein en org, ook onder een andere naam', async () => {
  const bl = buildBlocklist({ projects: [
    { name: 'Gully Chain', chainIds: [485590], domains: ['gullychain.xyz'] },
    { name: 'OneX Smart Chain', github: ['onex-chain'] },
    { name: 'Uit', chainIds: [1], enabled: false },
  ] });
  assert.equal(bl.match(rec({ name: 'Gully Chain Testnet', chainId: 999 })), true, 'naam');
  assert.equal(bl.match(rec({ name: 'Iets Anders', chainId: 485590 })), true, 'chain ID');
  assert.equal(bl.match(rec({ name: 'Nieuwe Naam', website: 'https://app.gullychain.xyz' })), true, 'domein');
  assert.equal(bl.match(rec({ name: 'X', rpc: ['https://rpc.gullychain.xyz'] })), true, 'RPC-domein');
  assert.equal(bl.match(rec({ name: 'OneX v2', website: 'https://github.com/onex-chain' })), true, 'org');
  assert.equal(bl.match(rec({ name: 'Ethereum', chainId: 1 })), false, 'uitgezette regel');
  assert.equal(bl.match(rec({ name: 'Ritual', chainId: 784 })), false);
  assert.equal(bl.matchDossier({ keys: ['id:485590'] }), true);
});

await t('K2: runner meldt een geblokkeerde chain niet en zet hem niet op de wachtlijst', async () => {
  await fs.rm(`${TMP}/e2e`, { recursive: true, force: true });
  await fs.mkdir(`${TMP}/e2e/data`, { recursive: true });
  await fs.writeFile(`${TMP}/e2e/data/blocklist.json`, JSON.stringify({ projects: [{ name: 'Scamchain', chainIds: [910001] }] }));
  const tg = await tgServer();
  try {
    const base = [{ chainId: 900001, name: 'Alpha Chain' }];
    await runner(base, tg, { DIGEST_ENABLED: 'false' });
    await runner([...base, { chainId: 910001, name: 'Scamchain' }, { chainId: 910002, name: 'Echtchain' }], tg, { DIGEST_ENABLED: 'false' });
    assert.ok(tg.sent.some((m) => /Echtchain/.test(m.text)), 'gewone chain wel gemeld');
    assert.ok(!tg.sent.some((m) => /Scamchain/.test(m.text)), 'geblokkeerde chain niet gemeld');
    const db = JSON.parse(await fs.readFile(`${TMP}/e2e/data/dossiers.json`, 'utf8'));
    assert.ok(Object.values(db.dossiers).some((d) => d.blocked), 'dossier gemarkeerd');
    const n = tg.sent.length;
    await runner([...base, { chainId: 910001, name: 'Scamchain' }, { chainId: 910002, name: 'Echtchain' }], tg, { DIGEST_ENABLED: 'false' });
    assert.equal(tg.sent.length, n, 'ook later niet');
  } finally {
    tg.close();
  }
});

// ---- Radar ------------------------------------------------------------------
const R = await import('../src/radar.js');
const B = await import('../src/briefing.js');
const ZK = await import('../src/sources/zk-bridgehub.js');
const { parseSpellbookValues } = await import('../src/labels.js');
const { namedContracts } = await import('../src/ecosystem.js');

const fakeSrc = (id, cat, items, opts = {}) => ({ id, cat, everyHours: 1, ...opts, fetch: async () => { if (opts.boom) throw new Error('kapot'); return items; } });
const at = new Date('2026-10-28T09:45:00Z');

await t('R1: radar legt eerst een nulmeting vast; alleen recente items tellen dan als nieuw', async () => {
  const radar = { items: [], seen: {}, health: {}, lastSent: null };
  const src = fakeSrc('t', 'techniek', [
    { key: 'a', title: 'Oud onderwerp', url: 'u', meta: { created: '2026-10-01' } },
    { key: 'b', title: 'Nieuw rollup-voorstel', url: 'u', meta: { created: '2026-10-27' } },
  ]);
  const r1 = await R.runRadar(radar, { sources: [src], now: at });
  assert.deepEqual(r1.added.map((x) => x.key), ['b']);
  src.fetch = async () => [{ key: 'a', title: 'x', url: 'u' }, { key: 'c', title: 'Echt nieuw', url: 'u' }];
  const r2 = await R.runRadar(radar, { sources: [src], now: at });
  assert.deepEqual(r2.added.map((x) => x.key), ['c'], 'alleen wat niet eerder gezien is');
});

await t('R2: kapotte radarbron houdt zijn storing bij en blokkeert de rest niet', async () => {
  const radar = { items: [], seen: {}, health: {}, lastSent: null };
  await R.runRadar(radar, { sources: [fakeSrc('kapot', 'sdk', [], { boom: true }), fakeSrc('heel', 'sdk', [])], now: at });
  assert.equal(radar.health.kapot.ok, false);
  assert.equal(radar.health.heel.ok, true);
});

await t('R3: bronnen draaien alleen in hun raam en ritme', async () => {
  assert.equal(R.isDue({ everyHours: 1 }, new Date('2026-10-28T09:45:00Z')), true);
  assert.equal(R.isDue({ everyHours: 1 }, new Date('2026-10-28T09:15:00Z')), false);
  assert.equal(R.isDue({ everyHours: 24 }, new Date('2026-10-28T09:45:00Z')), false);
  assert.equal(R.isDue({ everyHours: 24 }, new Date('2026-10-28T00:45:00Z')), true);
});

await t('R4: alleen rollup-systeemcontracten tellen, geen algemene namen', async () => {
  for (const n of ['OptimismPortal2', 'SequencerInbox', 'Bridgehub', 'DisputeGameFactory']) assert.ok(R.SYSTEM_CONTRACT.test(n), n);
  for (const n of ['Bridge', 'Inbox', 'Deposit', 'ERC20', 'OptimismPortalHelper']) assert.ok(!R.SYSTEM_CONTRACT.test(n), n);
  assert.ok(R.JOB_WORDS.test('Senior Protocol Engineer'));
  assert.ok(!R.JOB_WORDS.test('Account Servicing Associate'));
});

await t('R5: radarbericht: secties, dossierkoppeling, binnen de limiet, en eerlijk als het leeg is', async () => {
  const db = D.emptyDb();
  D.ingest(db, [rec({ key: 'x', source: 'chainlist', kind: 'testnet', name: 'Velocora Testnet', chainId: 8800001, url: 'v' })], { quiet: true });
  const radar = { items: [], health: {}, seen: {} };
  for (let i = 0; i < 40; i++) radar.items.push({ key: `f${i}`, cat: 'techniek', src: 'forums', date: '2026-10-28', title: `Based rollup preconf voorstel ${i} ${'x'.repeat(60)}`, url: `https://ethresear.ch/t/x/${i}`, meta: { forum: 'ethresear.ch' } });
  radar.items.push({ key: 's1', cat: 'audit', src: 'audit-sherlock', date: '2026-10-28', title: 'Velocora', url: 'https://audits.sherlock.xyz/contests/1', meta: { starts: '2026-11-03', ends: '2026-11-20', prize: 50000, token: 'USDC' } });
  const msgs = B.radarMessages(db, radar, { since: '2026-10-27', today: '2026-10-28', scoreFn: R.radarScore });
  for (const m of msgs) assert.ok(m.length <= limits.SAFE_LEN, `te lang: ${m.length}`);
  const all = msgs.join('\n');
  assert.match(all, /Audit-contests/);
  assert.match(all, /📁 velocora/);
  assert.match(all, /… en 32 meer/);
  const empty = B.radarMessages(D.emptyDb(), { items: [], health: {} }, { since: '2026-10-27', today: '2026-10-28' });
  assert.match(empty[0], /Niets nieuws op de radar/);
});

await t('R6: airdropscore telt signalen op en slaat imitaties en blocklist over', async () => {
  const db = D.emptyDb();
  D.ingest(db, [
    rec({ key: 'n', source: 'funding-rss', kind: 'lead', name: 'Velocora', url: 'n', detectedAt: '2026-10-20T00:00:00Z' }),
    rec({ key: 't', source: 'chainlist', kind: 'testnet', name: 'Velocora Testnet', chainId: 8800001, url: 't', detectedAt: '2026-10-21T00:00:00Z' }),
  ], { quiet: true });
  const audit = [{ cat: 'audit', title: 'Velocora', key: 'a' }];
  const c = B.airdropCandidates(db, audit, { today: '2026-10-28' });
  assert.equal(c.length, 1);
  assert.ok(c[0].why.includes('verse funding') && c[0].why.includes('audit-contest loopt'));
  db.dossiers[c[0].d.id].blocked = true;
  assert.equal(B.airdropCandidates(db, audit, { today: '2026-10-28' }).length, 0);
});

await t('R7: ZK Bridgehub-selectors kloppen en de array-decoder leest uint256[]', async () => {
  assert.equal(ZK.SEL_CHAIN_IDS, keccak256('getAllZKChainChainIDs()').slice(0, 10));
  assert.equal(ZK.SEL_CHAINS, keccak256('getAllZKChains()').slice(0, 10));
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const hex = `0x${w(32)}${w(2)}${w(324)}${w(2741)}`;
  assert.deepEqual(ZK.decodeWordArray(hex).map((x) => BigInt(`0x${x}`).toString()), ['324', '2741']);
  assert.deepEqual(ZK.decodeWordArray('0x'), []);
});

await t('R8: Spellbook-labels worden uit de SQL gelezen', async () => {
  const m = parseSpellbookValues(`values\n (0x0d3250c3d5facb74ac15834096397a3ef790ec99, 'zkSync Era', '', 'zksync')\n , (0xC1B634853Cb333D3aD8663715b08f41A3Aec47cc ,'Arbitrum One', '', 'arbitrum')`);
  assert.equal(m.get('0xc1b634853cb333d3ad8663715b08f41a3aec47cc'), 'Arbitrum One');
  assert.equal(m.size, 2);
});

await t('R9: geverifieerde dapp-contracten op een nieuwe chain worden op naam gefilterd', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [
      { address: { name: 'LaunchpadFactory', hash: '0x' + '1'.repeat(40) } },
      { address: { name: 'MyToken', hash: '0x' + '2'.repeat(40) } },
      { address: { name: 'BondingCurveRouter', hash: '0x' + '3'.repeat(40) } },
    ] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const list = await namedContracts(`http://127.0.0.1:${server.address().port}/`);
    assert.deepEqual(list.map((c) => c.name), ['LaunchpadFactory', 'BondingCurveRouter']);
  } finally {
    server.close();
  }
});

console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
