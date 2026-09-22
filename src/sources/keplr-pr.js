import { gh } from '../http.js';
import { classify, nameKey, clamp } from '../util.js';

const MAX_ENRICH = 40;
const CHAIN_FILE = /^(cosmos|evm|svm|bitcoin|starknet)\/[^/]+\.json$/;

/**
 * Open PRs op chainapsis/keplr-chain-registry. Het Cosmos-equivalent van de
 * ethereum-lists-aanvraag: een team voegt zijn chain toe zodat Keplr hem kan
 * tonen, meestal vlak voor of rond genesis. Vangt ook Cosmos-chains die nooit
 * een EVM chain-ID aanvragen en dus buiten chainid.network vallen.
 */
export default {
  id: 'keplr-pr',
  label: 'Keplr chain-registry open PRs (pre-launch)',
  url: 'https://github.com/chainapsis/keplr-chain-registry/pulls',

  async fetchAll() {
    const out = [];
    for (let page = 1; page <= 2; page++) {
      const prs = await gh(
        `/repos/chainapsis/keplr-chain-registry/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`
      );
      if (!Array.isArray(prs) || prs.length === 0) break;
      for (const pr of prs) {
        if (!pr?.number) continue;
        const name = clamp(String(pr.title || `PR #${pr.number}`).replace(/^\s*(add|feat|chore)\s*:?\s*/i, ''), 140);
        out.push({
          key: `keplrpr:${pr.number}`,
          source: 'keplr-pr',
          name,
          nameKey: nameKey(name, 'proposal'),
          kind: 'proposal',
          likelyKind: classify(name),
          ecosystem: 'Cosmos',
          chainId: null,
          rpc: [],
          explorers: [],
          faucets: [],
          url: pr.html_url || `https://github.com/chainapsis/keplr-chain-registry/pull/${pr.number}`,
          createdAt: pr.created_at || null,
          number: pr.number,
        });
      }
      if (prs.length < 100) break;
    }
    return out;
  },

  /** Bevestigt dat er echt een chain-bestand bij zit en haalt naam en RPC eruit. */
  async enrich(fresh) {
    const out = [];
    for (const rec of fresh.slice(0, MAX_ENRICH)) {
      let files;
      try {
        files = await gh(`/repos/chainapsis/keplr-chain-registry/pulls/${rec.number}/files?per_page=100`);
      } catch (e) {
        console.warn(`[keplr-pr] PR #${rec.number} files onbereikbaar (${e.message}), neem mee`);
        out.push(rec);
        continue;
      }
      if (!Array.isArray(files)) continue;

      const chainFile = files.find((f) => f.status === 'added' && CHAIN_FILE.test(f.filename || ''));
      if (!chainFile) continue;

      const patch = chainFile.patch || '';
      const nameInPatch = patch.match(/^\+\s*"chainName"\s*:\s*"([^"]{1,80})"/m);
      const idInPatch = patch.match(/^\+\s*"chainId"\s*:\s*"?([^",]{1,60})"?/m);
      const rest = patch.match(/^\+\s*"rest"\s*:\s*"(https?:\/\/[^"]+)"/m);
      const name = nameInPatch ? nameInPatch[1] : rec.name;
      const ecosystem = chainFile.filename.split('/')[0];
      out.push({
        ...rec,
        name,
        nameKey: nameKey(name, 'proposal'),
        chainId: idInPatch ? idInPatch[1].trim() : null,
        ecosystem: { cosmos: 'Cosmos', evm: 'EVM', svm: 'Solana/SVM', bitcoin: 'Bitcoin' }[ecosystem] || ecosystem,
        likelyKind: classify(name),
        rpc: rest ? [rest[1]] : [],
      });
    }
    if (fresh.length > MAX_ENRICH) {
      console.warn(`[keplr-pr] ${fresh.length - MAX_ENRICH} PRs niet verrijkt deze run`);
      out.push(...fresh.slice(MAX_ENRICH));
    }
    return out;
  },
};
