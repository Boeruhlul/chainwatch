/**
 * Gedempte testnets: Glacier levert elke Builder-Console-klik als testnet-L1
 * ('QR0923Q1TS' en consorten). Die horen in de state, niet in Telegram.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { websiteCandidates } from '../src/enrich.js';

const run = promisify(execFile);
const TMP = 'test/.tmp-muted';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
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

const chain = (id, name) => ({ chainId: id, name, rpc: [`https://rpc.${id}.test`] });

console.log('\nmuted-testnets tests\n');

await t('G1: testnets uit een gedempte bron worden opgeslagen maar niet gealert', async () => {
  await reset();
  const env = { MUTED_TESTNET_SOURCES: 'fixture' };
  await watch([chain(1, 'Ethereum')], env);
  const set = [chain(1, 'Ethereum'), chain(5, 'QR0923Q1TS Testnet'), chain(6, 'Echtnet')];
  const out = await watch(set, env);
  assert.match(out, /2 gedetecteerd, 1 alertwaardig/);
  assert.doesNotMatch(out, /QR0923Q1TS/);
  assert.match(out, /Echtnet/, 'mainnet uit dezelfde bron moet gewoon doorkomen');
  // Wel opgeslagen: de volgende run ziet hem niet opnieuw als nieuw.
  assert.match(await watch(set, env), /0 gedetecteerd/);
});

await t('G2: MUTED_TESTNET_SOURCES leeg = testnets van elke bron alerten weer', async () => {
  await reset();
  const env = { MUTED_TESTNET_SOURCES: '' };
  await watch([chain(1, 'Ethereum')], env);
  const out = await watch([chain(1, 'Ethereum'), chain(5, 'Foo Testnet')], env);
  assert.match(out, /1 gedetecteerd, 1 alertwaardig/);
});

await t('G3: avax.network is nooit de website van een Avalanche-L1', async () => {
  const c = {
    rpc: ['https://subnets.avax.network/qr0923q1ts/testnet/rpc'],
    explorers: ['https://explorer-test.avax.network/qr0923q1ts'],
  };
  assert.deepEqual(websiteCandidates(c), []);
  assert.deepEqual(websiteCandidates({ ...c, website: 'https://bodega.cash' }), ['bodega.cash'],
    'een eigen website moet wel blijven werken');
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail ? 1 : 0);
