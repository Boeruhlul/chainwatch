/**
 * Wankele bronnen (crt.sh): geen meldingsregen, geen commit-ruis.
 *
 * Aanleiding 2026-09-22: ct-hostnames stuurde vier storingsmeldingen binnen
 * een uur. Drie oorzaken, elk met een test hieronder:
 *   - de bron faalde al als één patroon mislukte en de rest terecht niets vond;
 *   - een tussentijds geslaagde run wiste lastNotifiedAt, dus de stilte van
 *     6 uur hield geen stand bij een bron die afwisselend faalt en slaagt;
 *   - health.json kreeg elke run een andere fouttekst en dus een commit.
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import http from 'node:http';

const run = promisify(execFile);
const TMP = 'test/.tmp-flaky';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

async function reset() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(`${TMP}/data`, { recursive: true });
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    CHAINWATCH_DATA: `${TMP}/data`, CHAINWATCH_DOCS: `${TMP}/docs`,
    CHAINWATCH_FIXTURE: `${TMP}/fixture.json`, PROBE_ENABLED: 'false', ...extra,
  };
}

async function watch(fixture, env = {}) {
  await fs.writeFile(`${TMP}/fixture.json`, JSON.stringify(fixture));
  try {
    const r = await run('node', ['src/index.js'], { env: baseEnv({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', ...env }) });
    return r.stdout + r.stderr;
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

function tgServer() {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { sent.push(JSON.parse(body)); } catch { /* negeer */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const watchTg = (fixture, tg, env = {}) =>
  watch(fixture, { CHAINWATCH_TG_API: tg.url, TELEGRAM_BOT_TOKEN: 'testtoken', TELEGRAM_CHAT_ID: '123', ...env });

const chain = (id, name) => ({ chainId: id, name, rpc: [`https://rpc.${id}.test`] });

console.log('\nwankele bronnen\n');

await t('C1: een bron die afwisselend faalt en slaagt breekt de stilteperiode niet', async () => {
  await reset();
  const tg = await tgServer();
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg('BOOM', tg);
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg('BOOM', tg);
  await watchTg([chain(1, 'Ethereum')], tg);
  await watchTg('BOOM', tg);
  tg.close();
  const storingen = tg.sent.filter((m) => /falen/.test(m.text));
  assert.equal(storingen.length, 1, `${storingen.length} storingsmeldingen binnen 6 uur`);
});

await t('C2: health.json blijft gelijk tussen twee gezonde runs na een storing', async () => {
  await reset();
  await watch([chain(1, 'Ethereum')]);
  await watch('BOOM');
  await watch([chain(1, 'Ethereum')]);
  const a = await fs.readFile(`${TMP}/data/health.json`, 'utf8');
  await watch([chain(1, 'Ethereum')]);
  const b = await fs.readFile(`${TMP}/data/health.json`, 'utf8');
  assert.equal(a, b, 'health.json verandert zonder dat er iets veranderd is');
  assert.doesNotMatch(b, /wasFailing/);
});

await t('C3: een bron met alarmdrempel meldt pas na een ononderbroken storing', async () => {
  await reset();
  const tg = await tgServer();
  const env = { FIXTURE_ALERT_AFTER_HOURS: '12' };
  await watchTg([chain(1, 'Ethereum')], tg, env);
  await watchTg('BOOM', tg, env);
  await watchTg('BOOM', tg, env);
  assert.equal(tg.sent.filter((m) => /falen/.test(m.text)).length, 0, 'te vroeg gemeld');

  // Storing 13 uur terugzetten: nu moet hij wel komen.
  const file = `${TMP}/data/health.json`;
  const h = JSON.parse(await fs.readFile(file, 'utf8'));
  h.fixture.failingSince = new Date(Date.now() - 13 * 3600000).toISOString();
  await fs.writeFile(file, JSON.stringify(h));
  await watchTg('BOOM', tg, env);
  tg.close();
  const storingen = tg.sent.filter((m) => /falen/.test(m.text));
  assert.equal(storingen.length, 1, 'langdurige storing niet gemeld');
  assert.match(storingen[0].text, /sinds 13 uur/);
});

const ct = await import('../src/sources/ct-hostnames.js');

await t('C4: rouleren dekt alle patronen binnen ceil(n/k) runs', async () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const t0 = 1_800_000_000_000;
  const gezien = new Set();
  for (let i = 0; i < 4; i++) for (const p of ct.pickPatterns(all, 2, t0 + i * 300000)) gezien.add(p);
  assert.equal(gezien.size, 7);
  assert.deepEqual(ct.pickPatterns(all, 10), all);
});

/** Nep-crt.sh: gedrag per patroon, met teller per patroon. */
function crtServer(plan) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q');
    hits[q] = (hits[q] || 0) + 1;
    const step = plan[q]?.[hits[q] - 1] ?? plan[q]?.at(-1) ?? 502;
    if (typeof step === 'number') { res.writeHead(step); return res.end('<html>kapot</html>'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ hits, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(env)) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); }
}

await t('C5: een geslaagde lege query plus een mislukte is GEEN bronfout', async () => {
  const srv = await crtServer({ 'rpc.ok.%': [[]], 'rpc.stuk.%': [502] });
  const recs = await withEnv(
    { CT_BASE_URL: srv.url, CT_PATTERNS: 'rpc.ok.%,rpc.stuk.%', CT_PATTERNS_PER_RUN: '2', CT_BUDGET_SECONDS: '8' },
    () => ct.default.fetchAll()
  );
  srv.close();
  assert.deepEqual(recs, []);
  assert.ok(srv.hits['rpc.stuk.%'] >= 2, 'geen retry op 502');
});

await t('C6: 404 van crt.sh wordt opnieuw geprobeerd; alles stuk = wel een fout', async () => {
  const now = new Date().toISOString();
  const srv = await crtServer({
    'rpc.herstel.%': [404, [{ name_value: 'rpc.herstel.voorbeeld.xyz', entry_timestamp: now }]],
    'rpc.dood.%': [502],
  });
  const env = { CT_BASE_URL: srv.url, CT_PATTERNS_PER_RUN: '1', CT_BUDGET_SECONDS: '8' };
  const recs = await withEnv({ ...env, CT_PATTERNS: 'rpc.herstel.%' }, () => ct.default.fetchAll());
  assert.deepEqual(recs.map((r) => r.host), ['rpc.herstel.voorbeeld.xyz']);
  await assert.rejects(
    withEnv({ ...env, CT_PATTERNS: 'rpc.dood.%' }, () => ct.default.fetchAll()),
    /crt\.sh onbereikbaar/
  );
  srv.close();
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
