import fs from 'node:fs/promises';
import path from 'node:path';
import { slug, clamp } from '../util.js';

/**
 * Onderzoeksbestanden: de inname van de wekelijkse deep research.
 *
 * Een geplande Claude-sessie doet het werk dat geen vaste bron kan: breed
 * zoeken, verbanden leggen, onbekende organisaties natrekken. Die sessie heeft
 * geen Telegram-token en hoort dat ook niet te hebben. Ze schrijft haar
 * vondsten als JSON in data/research/, en deze bron pikt dat op, zodat alles
 * via dezelfde dossiers, dezelfde dedupe en hetzelfde kanaal loopt.
 *
 * Formaat: een array van kandidaten met name, aliases, org, architecture,
 * stage, confidence (A–D), why, facts[{claim,url,date}], hypotheses[],
 * chainIds[], website, rpc[], explorer, ecosystem{}, expectedLaunch,
 * nextSignals[]. Zie RESEARCH.md.
 *
 * noBootstrap: de eerste keer dat de bron draait is het eerste
 * onderzoeksbestand juist nieuws, geen baseline om stil vast te leggen.
 */

const DATA = process.env.CHAINWATCH_DATA || 'data';
const DIR = path.join(DATA, 'research');
const STAGES = new Set(['rumor', 'development', 'devnet', 'testnet', 'private-mainnet', 'mainnet']);

const str = (v, n = 300) => (typeof v === 'string' && v.trim() ? clamp(v.trim(), n) : null);
const url = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);

/** Eén kandidaat netjes maken. Onbruikbaar = null; we gokken niets aan. */
export function normalizeCandidate(c, file) {
  const name = str(c?.name, 80);
  if (!name) return null;
  const conf = ['A', 'B', 'C', 'D'].includes(c.confidence) ? c.confidence : 'D';
  const stage = STAGES.has(c.stage) ? c.stage : 'rumor';
  const facts = (Array.isArray(c.facts) ? c.facts : [])
    .map((f) => ({ claim: str(f?.claim, 240), url: url(f?.url), date: str(f?.date, 20) }))
    .filter((f) => f.claim)
    .slice(0, 8);
  const research = {
    file,
    aliases: (c.aliases || []).map((a) => str(a, 60)).filter(Boolean).slice(0, 8),
    org: str(c.org, 80),
    architecture: str(c.architecture, 80),
    stage,
    confidence: conf,
    why: str(c.why, 400),
    facts,
    hypotheses: (c.hypotheses || []).map((h) => str(h, 240)).filter(Boolean).slice(0, 6),
    chainIds: (c.chainIds || []).filter((x) => x != null && x !== '').map(String).slice(0, 6),
    website: url(c.website),
    rpc: (c.rpc || []).map(url).filter(Boolean).slice(0, 3),
    explorer: url(c.explorer),
    ecosystem: c.ecosystem && typeof c.ecosystem === 'object' ? {
      dex: str(c.ecosystem.dex, 80), launchpad: str(c.ecosystem.launchpad, 80), bridge: str(c.ecosystem.bridge, 80),
    } : null,
    expectedLaunch: str(c.expectedLaunch, 60),
    nextSignals: (c.nextSignals || []).map((s) => str(s, 120)).filter(Boolean).slice(0, 6),
  };
  return {
    key: `research:${file.replace(/\.json$/, '')}:${slug(name)}`,
    source: 'research',
    name,
    nameKey: `${slug(name)}:research`,
    kind: 'research',
    ecosystem: research.architecture || 'onbekend',
    chainId: null,
    rpc: research.rpc,
    explorers: research.explorer ? [research.explorer] : [],
    faucets: [],
    website: research.website,
    description: research.why,
    url: facts.find((f) => f.url)?.url || research.website || null,
    research,
  };
}

export default {
  id: 'research',
  label: 'Deep research (data/research)',
  url: 'file://data/research',
  noBootstrap: true,

  async fetchAll() {
    let files;
    try {
      files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const file of files) {
      let arr;
      try {
        arr = JSON.parse(await fs.readFile(path.join(DIR, file), 'utf8'));
      } catch (e) {
        // Eén kapot onderzoeksbestand mag de rest niet tegenhouden, maar moet
        // wel opvallen: daarom als fout in de log én overslaan.
        console.error(`[research] ${file} onleesbaar: ${e.message}`);
        continue;
      }
      if (!Array.isArray(arr)) arr = Array.isArray(arr?.candidates) ? arr.candidates : [];
      for (const c of arr) {
        const r = normalizeCandidate(c, file);
        if (r) out.push(r);
      }
    }
    return out;
  },
};
