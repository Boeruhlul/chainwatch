import { evmCall, hexToNum } from '../evm.js';
import { nameKey } from '../util.js';

/**
 * Nieuwe ZK Stack-chains, rechtstreeks uit het Bridgehub-contract op Ethereum.
 *
 * Elke ZK Stack-chain (zkSync Elastic Network) wordt bij het Bridgehub
 * geregistreerd voordat hij iets kan doen. Dat is de ZK-tegenhanger van de
 * RollupCreator-scan voor Arbitrum Orbit: één eth_call per run, diff op het
 * resultaat, geen RPC van het team nodig.
 *
 * Bridgehub-adres uit docs.zksync.io/zk-stack/zk-chain-addresses.
 * Selectors: keccak256("getAllZKChainChainIDs()") = 0x68b8d331 en
 * keccak256("getAllZKChains()") = 0x49707f31; test/discovery.js rekent ze na.
 */

export const BRIDGEHUB = process.env.ZK_BRIDGEHUB || '0x303a465B659cBB0ab36eE643eA362c509EEb5213';
export const SEL_CHAIN_IDS = '0x68b8d331';
export const SEL_CHAINS = '0x49707f31';

/** ABI: dynamische uint256[]/address[] → array van 32-byte woorden. */
export function decodeWordArray(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 128) return [];
  const offset = Number.parseInt(h.slice(0, 64), 16) * 2;
  const len = Number.parseInt(h.slice(offset, offset + 64), 16);
  if (!Number.isFinite(len) || len > 10000) return [];
  const out = [];
  for (let i = 0; i < len; i++) {
    const w = h.slice(offset + 64 + i * 64, offset + 128 + i * 64);
    if (w.length === 64) out.push(w);
  }
  return out;
}

export default {
  id: 'zk-bridgehub',
  label: 'ZK Stack Bridgehub (nieuwe ZK-chains)',
  url: 'https://docs.zksync.io/zk-stack/zk-chain-addresses',

  async fetchAll() {
    let ids = [];
    try {
      const res = await evmCall('ethereum', 'eth_call', [{ to: BRIDGEHUB, data: SEL_CHAIN_IDS }, 'latest']);
      ids = decodeWordArray(res).map((w) => BigInt(`0x${w}`).toString());
    } catch { /* oudere Bridgehub: val terug op adressen */ }

    if (ids.length) {
      return ids.map((id) => ({
        key: `zk:${id}`,
        source: 'zk-bridgehub',
        name: `ZK Stack-chain ${id}`,
        nameKey: nameKey(`zkstack${id}`, 'mainnet'),
        kind: 'stealth',
        stealthKind: 'zk',
        ecosystem: 'ZK Stack (Elastic Network)',
        chainId: Number(id) <= Number.MAX_SAFE_INTEGER ? Number(id) : id,
        rpc: [], explorers: [], faucets: [],
        contract: null,
        url: `https://etherscan.io/address/${BRIDGEHUB}#readProxyContract`,
      }));
    }

    const res = await evmCall('ethereum', 'eth_call', [{ to: BRIDGEHUB, data: SEL_CHAINS }, 'latest']);
    const addrs = decodeWordArray(res).map((w) => `0x${w.slice(24)}`.toLowerCase());
    if (!addrs.length) throw new Error('Bridgehub gaf geen chains terug');
    return addrs.map((a) => ({
      key: `zkaddr:${a}`,
      source: 'zk-bridgehub',
      name: `ZK Stack-chain ${a.slice(0, 10)}…`,
      nameKey: nameKey(`zkstack${a}`, 'mainnet'),
      kind: 'stealth',
      stealthKind: 'zk',
      ecosystem: 'ZK Stack (Elastic Network)',
      chainId: null,
      rpc: [], explorers: [], faucets: [],
      contract: a,
      url: `https://etherscan.io/address/${a}`,
    }));
  },
};

export const _test = { hexToNum };
