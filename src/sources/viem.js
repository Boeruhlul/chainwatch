import { gh, getText } from '../http.js';
import { classify, nameKey } from '../util.js';

/**
 * viem chain-definities. Dit is een ONTWIKKELAARSSIGNAAL, geen register:
 * iemand voegt een chain-definitie toe omdat hij er tegenaan bouwt. Dat gebeurt
 * geregeld voordat de chain publiek is, en het is de snelste manier om te zien
 * dat er ueberhaupt iemand aan een netwerk werkt.
 */
function prettify(slug) {
  return slug
    .replace(/\.ts$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (ch) => ch.toUpperCase());
}

export default {
  id: 'viem',
  label: 'viem chain-definities (dev-signaal)',
  url: 'https://github.com/wevm/viem/tree/main/src/chains/definitions',

  async fetchAll() {
    // De contents-API geeft maximaal 1000 entries terug; viem zit daar ruim
    // onder. Loopt dat ooit vol, dan is de git-trees-API het alternatief.
    const files = await gh('/repos/wevm/viem/contents/src/chains/definitions', { timeout: 30000 });
    if (!Array.isArray(files)) throw new Error('onverwacht formaat: geen array');
    if (files.length < 50) throw new Error(`onverwacht weinig definities: ${files.length}`);

    return files
      .filter((f) => f?.type === 'file' && /\.ts$/.test(f.name) && !/\.test\.ts$/.test(f.name))
      .map((f) => {
        const name = prettify(f.name);
        const kind = classify(name);
        return {
          key: `viem:${f.name}`,
          source: 'viem',
          name,
          nameKey: nameKey(name, kind),
          kind,
          ecosystem: 'EVM',
          chainId: null,
          rpc: [],
          explorers: [],
          faucets: [],
          url: f.html_url || 'https://github.com/wevm/viem/tree/main/src/chains/definitions',
        };
      });
  },

  /**
   * Haalt de echte chain-ID, RPC en explorer uit het definitiebestand. Alleen
   * voor nieuwe bestanden, dus normaal nul tot drie calls per run.
   */
  async enrich(fresh) {
    const out = [];
    for (const rec of fresh.slice(0, 15)) {
      try {
        const { text } = await getText(
          `https://raw.githubusercontent.com/wevm/viem/main/src/chains/definitions/${rec.key.slice(5)}`,
          { timeout: 12000, maxBytes: 40000 }
        );
        // Op het eerste inspringniveau, anders pakken we velden uit
        // nativeCurrency of contracts.
        const id = text.match(/^\s{2}id:\s*([\d_]+)/m);
        const name = text.match(/^\s{2}name:\s*'([^']{1,80})'/m);
        const symbol = text.match(/nativeCurrency:\s*\{[^}]*symbol:\s*'([^']{1,12})'/s);
        const rpc = text.match(/http:\s*\[\s*'(https?:\/\/[^']+)'/);
        const explorer = text.match(/blockExplorers:\s*\{[^}]*url:\s*'(https?:\/\/[^']+)'/s);
        const finalName = name ? name[1] : rec.name;
        out.push({
          ...rec,
          name: finalName,
          nameKey: nameKey(finalName, classify(finalName)),
          kind: classify(finalName),
          chainId: id ? Number(id[1].replace(/_/g, '')) : null,
          nativeCurrency: symbol ? symbol[1] : null,
          rpc: rpc ? [rpc[1]] : [],
          explorers: explorer ? [explorer[1]] : [],
        });
      } catch (e) {
        console.warn(`[viem] ${rec.key} niet te lezen (${e.message}), neem ruwe record mee`);
        out.push(rec);
      }
    }
    if (fresh.length > 15) out.push(...fresh.slice(15));
    return out;
  },
};