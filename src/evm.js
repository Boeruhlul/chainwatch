import { sleep } from './http.js';

/**
 * Minimale JSON-RPC-client voor de moederketens, met uitwijk naar een volgend
 * endpoint als er eentje weigert.
 *
 * Gratis publieke endpoints zijn wisselvallig: ze raten limieten, gaan even
 * plat, of weigeren een te groot blokbereik. Daarom altijd meerdere per keten
 * en nooit hard falen op de eerste.
 */

const DEFAULT_ENDPOINTS = {
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://eth.drpc.org',
    'https://rpc.ankr.com/eth',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.drpc.org',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
  ],
};

/**
 * Endpoints voor een keten. Met EVM_RPC_ETHEREUM=<url,url> overrule je de
 * standaardlijst, bijvoorbeeld met een eigen Alchemy- of drpc-sleutel.
 */
export function endpointsFor(chain) {
  const override = process.env[`EVM_RPC_${chain.toUpperCase()}`];
  if (override) {
    const list = override.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return DEFAULT_ENDPOINTS[chain] || [];
}

async function rpcOnce(url, method, params, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(body.error.message || 'rpc error');
    return body?.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Probeert de endpoints op volgorde; gooit pas als ze allemaal weigeren. */
export async function evmCall(chain, method, params = [], { timeout = 15000 } = {}) {
  const urls = endpointsFor(chain);
  if (!urls.length) throw new Error(`geen RPC-endpoints voor ${chain}`);
  let lastErr;
  for (const [i, url] of urls.entries()) {
    try {
      return await rpcOnce(url, method, params, timeout);
    } catch (e) {
      lastErr = new Error(`${new URL(url).host}: ${e.message}`);
      if (i < urls.length - 1) await sleep(250);
    }
  }
  throw lastErr;
}

export const hexToNum = (h) => (typeof h === 'string' ? Number.parseInt(h, 16) : null);
export const numToHex = (n) => `0x${Number(n).toString(16)}`;

/** Laatste 20 bytes van een 32-byte topic: een adres. */
export function topicToAddress(topic) {
  if (typeof topic !== 'string' || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Splitst het data-veld van een logbericht in 32-byte woorden en leest die als
 * adressen. Defensief: oudere versies van een contract hebben minder velden,
 * en dan willen we de velden die er wél zijn, niet een uitzondering.
 */
export function addressWords(data) {
  const hex = String(data || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const word = hex.slice(i, i + 64);
    // Een adres staat rechts uitgelijnd; de eerste 24 tekens horen nul te zijn.
    if (!/^0{24}/.test(word)) { out.push(null); continue; }
    out.push(`0x${word.slice(24)}`.toLowerCase());
  }
  return out;
}

export const _test = { DEFAULT_ENDPOINTS };
