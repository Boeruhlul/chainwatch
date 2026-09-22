import { gh } from '../http.js';
import { classify, nameKey, clamp, uniq } from '../util.js';

/**
 * Open pull requests op ethereum-lists/chains.
 * Dit is het VROEGSTE signaal dat bestaat voor een EVM chain: een team registreert
 * zijn chain ID vaak dagen tot weken voor de publieke launch.
 *
 * We filteren bewust NIET op PR-titel — die zijn te divers ("Add Lisk Sepolia",
 * "feat: add Monad", "Foobar chain addition") en een titelregex laat er
 * gegarandeerd doorheen glippen. In plaats daarvan nemen we elke open PR mee en
 * bevestigen we in enrich() via de files-API of er echt een chain-bestand bij zit.
 * Die call gebeurt alleen voor PRs die we nog niet gezien hebben, dus na de
 * bootstrap zijn dat er een handvol per run.
 */
const MAX_ENRICH = 60;

function cleanTitle(title, number) {
  const t = String(title || '')
    .replace(/^\s*(?:\[[^\]]*\]\s*)?(?:feat|fix|chore|docs)\s*:\s*/i, '')
    // Langste alternatief eerst, anders matcht 'add' in 'adding' en blijft 'ing' over.
    .replace(/^\s*(adding|creating|updating|added|create|update|adds|add|new)\b\s*/i, '')
    .replace(/^\s*(chain|network)\b\s*:?\s*/i, '')
    .replace(/^[:\-–\s]+/, '')
    .trim();
  return clamp(t || `PR #${number}`, 140);
}

export default {
  id: 'ethlists-pr',
  label: 'ethereum-lists/chains open PRs (pre-launch)',
  url: 'https://github.com/ethereum-lists/chains/pulls',

  async fetchAll() {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const prs = await gh(
        `/repos/ethereum-lists/chains/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`
      );
      if (!Array.isArray(prs) || prs.length === 0) break;
      for (const pr of prs) {
        if (!pr?.number) continue;
        const name = cleanTitle(pr.title, pr.number);
        const idMatch =
          String(pr.title || '').match(/eip155-(\d+)/i) || String(pr.head?.ref || '').match(/eip155-(\d+)/i);
        out.push({
          key: `ethpr:${pr.number}`,
          source: 'ethlists-pr',
          name,
          nameKey: nameKey(name, 'proposal'),
          kind: 'proposal',
          likelyKind: classify(name),
          ecosystem: 'EVM',
          chainId: idMatch ? Number(idMatch[1]) : null,
          rpc: [],
          explorers: [],
          faucets: [],
          url: pr.html_url || `https://github.com/ethereum-lists/chains/pull/${pr.number}`,
          author: pr.user?.login || null,
          createdAt: pr.created_at || null,
          number: pr.number,
        });
      }
      if (prs.length < 100) break;
    }
    return out;
  },

  /**
   * Bevestigt per nieuwe PR of er een chain-definitie in zit en haalt de echte
   * chain-gegevens uit het toegevoegde bestand. PRs zonder chain-bestand
   * (README-fixes, icon-updates) vallen hier af.
   */
  async enrich(fresh) {
    const out = [];
    for (const rec of fresh.slice(0, MAX_ENRICH)) {
      let files;
      try {
        files = await gh(`/repos/ethereum-lists/chains/pulls/${rec.number}/files?per_page=100`);
      } catch (e) {
        // Bij twijfel meenemen: liever een alert te veel dan een gemiste chain.
        console.warn(`[ethlists-pr] PR #${rec.number} files onbereikbaar (${e.message}), neem mee`);
        out.push(rec);
        continue;
      }
      if (!Array.isArray(files)) continue;

      const chainFile = files.find(
        (f) => f.status === 'added' && /^_data\/chains\/.+\.json$/.test(f.filename || '')
      );
      if (!chainFile) continue;

      const idMatch = chainFile.filename.match(/eip155-(\d+)\.json$/i);

      // De patch is een diff van een NIEUW bestand, dus alle '+'-regels samen
      // zijn de complete JSON. Die parsen we liever dan er regex op los te
      // laten: zo krijgen we in een klap infoURL, RPC, explorer en token mee.
      const chain = parseAddedJson(chainFile.patch || '');
      const name = chain?.name || rec.name;
      const faucets = uniq(chain?.faucets || fallbackFaucets(chainFile.patch || ''));

      out.push({
        ...rec,
        name,
        nameKey: nameKey(name, 'proposal'),
        chainId: chain?.chainId ?? rec.chainId ?? (idMatch ? Number(idMatch[1]) : null),
        likelyKind: classify(name, { faucets }),
        nativeCurrency: chain?.nativeCurrency?.symbol || null,
        rpc: uniq((chain?.rpc || []).filter((u) => typeof u === 'string' && !u.includes('${'))).slice(0, 3),
        explorers: uniq((chain?.explorers || []).map((e) => e?.url)).slice(0, 2),
        faucets: faucets.slice(0, 2),
        website: chain?.infoURL || null,
        parent: chain?.parent?.chain || null,
      });
    }
    if (fresh.length > MAX_ENRICH) {
      console.warn(`[ethlists-pr] ${fresh.length - MAX_ENRICH} PRs niet verrijkt deze run`);
      out.push(...fresh.slice(MAX_ENRICH));
    }
    return out;
  },
};

/** Alle toegevoegde regels van een nieuw-bestand-diff samen zijn de hele JSON. */
function parseAddedJson(patch) {
  const body = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  if (!body.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed?.chainId != null || parsed?.name ? parsed : null;
  } catch {
    // GitHub kapt patches af boven ~1 MB, en een PR die een bestaand bestand
    // wijzigt geeft geen contigue JSON. Dan valt de caller terug op de titel.
    return null;
  }
}

function fallbackFaucets(patch) {
  return [...patch.matchAll(/^\+\s*"(https?:\/\/[^"]*faucet[^"]*)"/gim)].map((m) => m[1]);
}
