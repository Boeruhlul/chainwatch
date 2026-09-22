import { gh, getText } from '../http.js';
import { classify, nameKey, uniq } from '../util.js';

const MAX_ENRICH = 25;

/**
 * Commits op ethereum-lists/chains die _data/chains raken.
 *
 * Waarom naast de chainlist-bron: chainid.network wordt pas herbouwd nadat een
 * PR gemerged is, en die build loopt achter. De commit is het moment zelf.
 * Bovendien zien we hier chains waarvan de PR gemerged wordt terwijl onze
 * PR-bron hem nog als 'open' kende — dan is dit het live-gaan-signaal.
 */
export default {
  id: 'ethlists-commit',
  label: 'ethereum-lists/chains commits',
  url: 'https://github.com/ethereum-lists/chains/commits/master/_data/chains',

  async fetchAll() {
    const commits = await gh(
      '/repos/ethereum-lists/chains/commits?path=_data/chains&per_page=30'
    );
    if (!Array.isArray(commits)) throw new Error('onverwacht formaat: geen array');

    return commits.filter((c) => c?.sha).map((c) => {
      const title = String(c.commit?.message || '').split('\n')[0].slice(0, 140);
      return {
        key: `ethcommit:${c.sha}`,
        source: 'ethlists-commit',
        name: title || c.sha.slice(0, 7),
        nameKey: `commit${c.sha.slice(0, 12)}:pre`, // per commit uniek tot enrich de echte naam kent
        kind: 'proposal',
        ecosystem: 'EVM',
        chainId: null,
        rpc: [],
        explorers: [],
        faucets: [],
        url: c.html_url || `https://github.com/ethereum-lists/chains/commit/${c.sha}`,
        sha: c.sha,
      };
    });
  },

  /**
   * Alleen commits die een NIEUW chain-bestand toevoegen zijn interessant;
   * icon-updates en RPC-correcties vallen hier af. Van een toegevoegd bestand
   * lezen we de volledige JSON, dus deze bron levert direct complete gegevens.
   */
  async enrich(fresh) {
    const out = [];
    for (const rec of fresh.slice(0, MAX_ENRICH)) {
      let detail;
      try {
        detail = await gh(`/repos/ethereum-lists/chains/commits/${rec.sha}`);
      } catch (e) {
        console.warn(`[ethlists-commit] ${rec.sha.slice(0, 7)} onbereikbaar (${e.message})`);
        continue; // zonder bevestiging liever stil: de chainlist-bron vangt hem alsnog
      }
      const added = (detail?.files || []).filter(
        (f) => f.status === 'added' && /^_data\/chains\/eip155-\d+\.json$/.test(f.filename || '')
      );
      for (const f of added) {
        const chain = await readChainJson(f, rec.sha);
        if (!chain) continue;
        const kind = classify(chain.name, { faucets: chain.faucets });
        out.push({
          ...rec,
          key: `ethcommit:${chain.chainId}`, // dedupe op chain, niet op commit
          name: chain.name,
          nameKey: nameKey(chain.name, kind),
          kind,
          chainId: chain.chainId,
          nativeCurrency: chain.nativeCurrency?.symbol || null,
          rpc: uniq((chain.rpc || []).filter((u) => typeof u === 'string' && !u.includes('${'))).slice(0, 3),
          explorers: uniq((chain.explorers || []).map((e) => e?.url)).slice(0, 2),
          faucets: uniq(chain.faucets || []).slice(0, 2),
          website: chain.infoURL || null,
          parent: chain.parent?.chain || null,
          url: `https://github.com/ethereum-lists/chains/blob/master/${f.filename}`,
        });
      }
    }
    return out;
  },
};

/** Leest de toegevoegde chain-JSON: eerst uit de patch, anders het ruwe bestand. */
async function readChainJson(file, sha) {
  const patch = file.patch || '';
  if (patch) {
    const body = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    try {
      const parsed = JSON.parse(body);
      if (parsed?.chainId != null && parsed?.name) return parsed;
    } catch { /* patch afgekapt of niet-contigu; val terug op raw */ }
  }
  try {
    const { text } = await getText(
      `https://raw.githubusercontent.com/ethereum-lists/chains/${sha}/${file.filename}`,
      { timeout: 10000, maxBytes: 50000 }
    );
    const parsed = JSON.parse(text);
    return parsed?.chainId != null ? parsed : null;
  } catch {
    return null;
  }
}
