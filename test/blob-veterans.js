/**
 * Regressietest voor blob-submitters: een ongelabelde afzender met een lange
 * geschiedenis is geen nieuwe rollup.
 *
 * Echt geval 2026-09-22: een Aztec-proposer (nonce 26481) kwam binnen als
 * "naamloze rollup" omdat Blobscan de losse proposers van Aztec niet labelt.
 */
import assert from 'node:assert/strict';
import { dropVeterans } from '../src/sources/blob-submitters.js';

const aztec = '0xb335e34e8b488718b70cdea29c4f8c2ea5c14bb4';
const vers = '0xeee0000000000000000000000000000000000005';
const onbekend = '0xfff0000000000000000000000000000000000006';
const nonces = { [aztec]: 26481, [vers]: 12 };
const getNonce = async (a) => {
  if (a === onbekend) throw new Error('alle endpoints weigeren');
  return nonces[a];
};

try {
  const recs = [aztec, vers, onbekend].map((a) => ({ key: `blob:${a}`, contract: a }));
  const kept = await dropVeterans(recs, getNonce, { maxNonce: 1000 });
  const addrs = kept.map((r) => r.contract);
  assert.ok(!addrs.includes(aztec), 'afzender met 26481 transacties mag geen alert worden');
  assert.ok(addrs.includes(vers), 'vers adres moet blijven');
  assert.ok(addrs.includes(onbekend), 'bij een RPC-fout moet het record blijven staan');
  assert.equal(kept.find((r) => r.contract === vers).senderNonce, 12);
  const grens = await dropVeterans([{ contract: vers }], async () => 1000, { maxNonce: 1000 });
  assert.equal(grens.length, 1, 'precies op de grens telt nog als nieuw');
  console.log('  \u2713 T9: blob-afzender met lange geschiedenis is geen nieuwe rollup (Aztec-proposer)');
} catch (e) {
  console.error(`  \u2717 T9: ${e.message}`);
  process.exit(1);
}
