import { getText } from '../http.js';
import { classify, nameKey } from '../util.js';

const URL = 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/metadata.yaml';

/**
 * Hyperlane registry: chains waar de interoperability-laag op uitgerold is.
 * Een rollup-as-a-service launch zet Hyperlane vaak neer voordat er publieke
 * RPC-documentatie is. Dekt ook non-EVM (Cosmos, Sealevel, Starknet).
 *
 * Bewust GEEN YAML-library: de tool heeft nul dependencies en we hebben maar
 * een handvol velden nodig. De parser leest alleen top-level blokken en een
 * paar scalaire sleutels daarbinnen — geen volledige YAML-semantiek.
 */
export function parseBlocks(yaml) {
  const blocks = new Map();
  let current = null;
  let lines = [];
  for (const line of String(yaml).split('\n')) {
    const top = line.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*):\s*$/);
    if (top) {
      if (current) blocks.set(current, lines.join('\n'));
      current = top[1];
      lines = [];
    } else if (current) {
      lines.push(line);
    }
  }
  if (current) blocks.set(current, lines.join('\n'));
  return blocks;
}

/** Scalar op het eerste inspringniveau van een blok. */
function field(block, key) {
  const m = block.match(new RegExp(`^  ${key}:[ \\t]*(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '') || null;
}

const PROTOCOL_LABEL = {
  ethereum: 'EVM',
  cosmos: 'Cosmos',
  cosmosnative: 'Cosmos',
  sealevel: 'Solana/SVM',
  starknet: 'Starknet',
  fuel: 'Fuel',
  radix: 'Radix',
};

export default {
  id: 'hyperlane',
  label: 'Hyperlane registry',
  url: 'https://github.com/hyperlane-xyz/hyperlane-registry',

  async fetchAll() {
    const { text } = await getText(URL, { timeout: 30000, maxBytes: 4000000 });
    const blocks = parseBlocks(text);
    if (blocks.size < 10) throw new Error(`onverwacht formaat: ${blocks.size} blokken`);

    const out = [];
    for (const [slugKey, block] of blocks) {
      const name = field(block, 'displayName') || field(block, 'name') || slugKey;
      const isTest = field(block, 'isTestnet') === 'true';
      const kind = isTest ? 'testnet' : classify(name);
      const protocol = (field(block, 'protocol') || '').toLowerCase();
      const explorer = block.match(/^\s+url:\s*(https?:\/\/\S+)/m);
      const rpc = block.match(/^\s+-?\s*http:\s*(https?:\/\/\S+)/m);
      const chainId = field(block, 'chainId');
      out.push({
        key: `hyperlane:${slugKey}`,
        source: 'hyperlane',
        name,
        nameKey: nameKey(name, kind),
        kind,
        ecosystem: PROTOCOL_LABEL[protocol] || protocol || 'onbekend',
        chainId: chainId && /^\d+$/.test(chainId) ? Number(chainId) : chainId,
        rpc: rpc ? [rpc[1]] : [],
        explorers: explorer ? [explorer[1]] : [],
        faucets: [],
        url: `https://github.com/hyperlane-xyz/hyperlane-registry/tree/main/chains/${slugKey}`,
      });
    }
    return out;
  },
};
