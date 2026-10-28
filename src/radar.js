import fs from 'node:fs/promises';
import path from 'node:path';
import { getJson, gh } from './http.js';
import { clamp } from './util.js';

/**
 * Radar: alles wat vóór een lancering zichtbaar is, maar geen chain is.
 *
 * Audit-contests (3–7 weken vóór mainnet), nieuw geverifieerde rollup-
 * contracten op Ethereum en L2's, onderzoeksfora en standaardvoorstellen
 * (maanden vooruit), nieuwe SDK's op npm, nieuwe bug bounties en vacatures bij
 * bedrijven die een chain zouden kunnen bouwen.
 *
 * Geen directe alerts: alles verzamelt zich in data/radar.json en gaat één
 * keer per dag als ochtendbericht de deur uit (zie briefing.js). Elke bron
 * draait op zijn eigen ritme (elk uur of eens per dag) en faalt los.
 *
 * Commit-ruis: radar.json verandert alleen als er iets nieuws bij komt; de
 * datums zijn dagen. De seen-sets zijn begrensd.
 */

const DATA = process.env.CHAINWATCH_DATA || 'data';
export const RADAR_FILE = path.join(DATA, 'radar.json');
const KEEP_DAYS = 14;
const SEEN_CAP = 4000;

const day = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Opslag
// ---------------------------------------------------------------------------

export async function loadRadar(file = RADAR_FILE) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { items: [], seen: {}, health: {}, lastSent: null };
    throw new Error(`kan ${file} niet lezen: ${e.message}`);
  }
  try {
    const r = JSON.parse(raw);
    return { items: r.items || [], seen: r.seen || {}, health: r.health || {}, lastSent: r.lastSent || null };
  } catch (e) {
    throw new Error(`${file} is corrupt (${e.message})`);
  }
}

export async function saveRadar(radar, file = RADAR_FILE) {
  const seen = {};
  for (const id of Object.keys(radar.seen).sort()) seen[id] = [...radar.seen[id]].sort().slice(-SEEN_CAP);
  const items = [...radar.items].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const out = { lastSent: radar.lastSent, health: radar.health, items, seen };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(out, null, 1));
  await fs.rename(`${file}.tmp`, file);
}

// ---------------------------------------------------------------------------
// Bronnen
// ---------------------------------------------------------------------------

/** Discourse-fora: onderzoek en governance. latest.json?order=created werkt zonder sleutel. */
export const FORUMS = (process.env.RADAR_FORUMS ||
  'ethresear.ch,ethereum-magicians.org,delvingbitcoin.org,gov.optimism.io,forum.arbitrum.foundation,' +
  'forum.celestia.org,forum.solana.com,community.starknet.io,forum.zknation.io,forum.polygon.technology,forum.cosmos.network')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Vergaderverslagen, spam en supportvragen zijn geen nieuwe techniek. */
export const FORUM_NOISE = /\b(which are the best|best .* compan(y|ies)|development compan|top \d+ |meeting #|breakout #|office hours?|call #|roundup|delegate (communication|thread)|delegate platform|support\b|hello\b|withdrawal .* (stuck|timing out)|airdrop claim help)/i;

const PROPOSAL_REPOS = ['ethereum/EIPs', 'ethereum/ERCs', 'solana-foundation/solana-improvement-documents', 'bitcoin/bips'];

/** Blockscout-instanties waarop we rollup-systeemcontracten zoeken. */
const L1_EXPLORERS = (process.env.RADAR_EXPLORERS ||
  'eth.blockscout.com,base.blockscout.com,arbitrum.blockscout.com,optimism.blockscout.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Contractnamen die verraden dat er een rollup of chain wordt opgezet. Bewust
 * geen kale "Bridge" of "Inbox": die zijn te algemeen.
 */
export const SYSTEM_CONTRACT = /^(OptimismPortal2?|L2OutputOracle|DisputeGameFactory|SystemConfig(Interop)?|AnchorStateRegistry|SequencerInbox|RollupProxy|RollupAdminLogic|RollupUserLogic|EdgeChallengeManager|Bridgehub|ChainTypeManager|StateTransitionManager|ValidatorTimelock|PolygonRollupManager|PolygonZkEVMBridgeV2|AggLayerGateway|BlobstreamX|SP1Blobstream)$/;

const TECH_WORDS = /\b(rollup|l2|l3|layer[- ]?[123]|chain|testnet|mainnet|launch|sequencer|preconf\w*|based|zk\w*|proof|prover|bridge|token|airdrop|points|upgrade|fork|consensus|da\b|data availability|interop|native|account abstraction|mev|restaking)\b/gi;

export const JOB_WORDS = /\b(protocol|blockchain|layer[- ]?2|l2|rollup|sequencer|validator|consensus|zk|zero[- ]knowledge|cryptograph\w*|evm|solidity|smart contracts?|stablecoins?|onchain|on-chain|node infrastructure|distributed ledger)\b/i;

const ago = (days) => Date.now() - days * 86400000;

export const SOURCES = [
  {
    id: 'audit-sherlock',
    cat: 'audit',
    everyHours: 3,
    async fetch() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const res = await getJson(`https://mainnet-contest.sherlock.xyz/contests?page=${page}`, { timeout: 20000, retries: 1 });
        for (const c of res?.items || []) {
          const ends = Number(c.ends_at) * 1000;
          // Afgelopen contests zijn geen nieuws; lopende en aankomende wel.
          if (c.status === 'FINISHED' || (Number.isFinite(ends) && ends < ago(2))) continue;
          const starts = Number(c.starts_at) * 1000;
          out.push({
            key: `sherlock:${c.id}`,
            title: c.title,
            url: `https://audits.sherlock.xyz/contests/${c.id}`,
            meta: {
              status: c.status, type: c.type_label,
              starts: Number.isFinite(starts) ? day(new Date(starts)) : null,
              ends: Number.isFinite(ends) ? day(new Date(ends)) : null,
              prize: c.prize_pool, token: c.token,
              about: clamp(c.short_description || '', 160),
            },
          });
        }
        if (!res?.has_next) break;
      }
      return out;
    },
  },
  {
    id: 'audit-repos',
    cat: 'audit',
    everyHours: 3,
    async fetch() {
      const out = [];
      for (const org of ['sherlock-audit', 'code-423n4', 'Cyfrin', 'hats-finance']) {
        try {
          const repos = await gh(`/orgs/${org}/repos?sort=created&direction=desc&per_page=30`, { retries: 1 });
          for (const r of repos || []) {
            if (Date.parse(r.created_at) < ago(21)) continue;
            out.push({
              key: `auditrepo:${r.full_name.toLowerCase()}`,
              title: r.name,
              url: r.html_url,
              meta: { org, created: day(new Date(r.created_at)), about: clamp(r.description || '', 160) },
            });
          }
        } catch { /* org niet bereikbaar: volgende */ }
      }
      return out;
    },
  },
  {
    id: 'verified-contracts',
    cat: 'contracten',
    everyHours: 1,
    async fetch() {
      const out = [];
      let ok = 0;
      for (const host of L1_EXPLORERS) {
        let params = '';
        try {
          for (let p = 0; p < 4; p++) {
            const res = await getJson(`https://${host}/api/v2/smart-contracts?q=&filter=solidity${params}`, { timeout: 20000, retries: 1 });
            ok++;
            for (const it of res?.items || []) {
              const name = it?.address?.name;
              const addr = it?.address?.hash;
              if (!name || !addr || !SYSTEM_CONTRACT.test(name)) continue;
              out.push({
                key: `vc:${host}:${addr.toLowerCase()}`,
                title: `${name} geverifieerd op ${host.split('.')[0]}`,
                url: `https://${host}/address/${addr}`,
                meta: { name, chain: host.split('.')[0], addr, verified: it.verified_at ? day(new Date(it.verified_at)) : null },
              });
            }
            const n = res?.next_page_params;
            if (!n) break;
            params = '&' + Object.entries(n).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
          }
        } catch { /* instantie onbereikbaar */ }
      }
      if (!ok) throw new Error('geen enkele Blockscout-instantie bereikbaar');
      return out;
    },
  },
  {
    id: 'forums',
    cat: 'techniek',
    everyHours: 2,
    async fetch() {
      const out = [];
      let ok = 0;
      for (const host of FORUMS) {
        try {
          const res = await getJson(`https://${host}/latest.json?order=created`, { timeout: 15000, retries: 0 });
          ok++;
          for (const t of res?.topic_list?.topics || []) {
            if (t.pinned || !t.title || Date.parse(t.created_at) < ago(7) || FORUM_NOISE.test(t.title)) continue;
            out.push({
              key: `forum:${host}:${t.id}`,
              title: t.title,
              url: `https://${host}/t/${t.slug}/${t.id}`,
              meta: { forum: host, created: day(new Date(t.created_at)), posts: t.posts_count, views: t.views },
            });
          }
        } catch { /* forum onbereikbaar */ }
      }
      if (!ok) throw new Error('geen enkel forum bereikbaar');
      return out;
    },
  },
  {
    id: 'proposals',
    cat: 'techniek',
    everyHours: 3,
    async fetch() {
      const out = [];
      for (const repo of PROPOSAL_REPOS) {
        try {
          const prs = await gh(`/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20`, { retries: 1 });
          for (const p of prs || []) {
            if (Date.parse(p.created_at) < ago(7)) continue;
            // Typo-fixes en editorial werk zijn geen nieuwe techniek.
            if (/\b(typo|fix(es)? link|editorial|spelling|update (status|author))\b/i.test(p.title)) continue;
            out.push({
              key: `pr:${repo.toLowerCase()}#${p.number}`,
              title: p.title,
              url: p.html_url,
              meta: { repo, created: day(new Date(p.created_at)) },
            });
          }
        } catch { /* repo onbereikbaar */ }
      }
      return out;
    },
  },
  {
    id: 'npm-sdk',
    cat: 'sdk',
    everyHours: 6,
    async fetch() {
      const out = [];
      for (const kw of ['rollup', 'appchain', 'testnet', 'l2', 'layer2', 'op-stack', 'orbit', 'zk-stack']) {
        try {
          const res = await getJson(`https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(kw)}&size=50`, { timeout: 15000, retries: 1 });
          for (const o of res?.objects || []) {
            const p = o.package;
            if (!p?.name || Date.parse(p.date) < ago(3)) continue;
            // Alleen pakketten die zelf nieuw zijn, niet elke patch van een oud pakket.
            if (p.version && !/^0\.0\.|^0\.1\.0$|^1\.0\.0$/.test(p.version)) continue;
            out.push({
              key: `npm:${p.name}`,
              title: p.name,
              url: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
              meta: { version: p.version, about: clamp(p.description || '', 160), keyword: kw },
            });
          }
        } catch { /* volgende */ }
      }
      return out;
    },
  },
  {
    id: 'immunefi',
    cat: 'bounty',
    everyHours: 24,
    async fetch() {
      const list = await getJson('https://immunefi.com/public-api/bounties.json', { timeout: 60000, retries: 1 });
      if (!Array.isArray(list)) throw new Error('onverwacht formaat');
      return list
        .filter((b) => b?.slug && Date.parse(b.launchDate) > ago(30))
        .map((b) => ({
          key: `immunefi:${b.slug}`,
          title: b.project,
          url: `https://immunefi.com/bug-bounty/${b.slug}/`,
          meta: {
            launched: b.launchDate ? day(new Date(b.launchDate)) : null,
            ecosystem: (b.ecosystem || []).slice(0, 3).join(', '),
            type: (b.productType || []).slice(0, 2).join(', '),
            max: b.maxBounty, website: b.websiteUrl || null,
          },
        }));
    },
  },
  {
    id: 'jobs',
    cat: 'vacature',
    everyHours: 24,
    async fetch(ctx) {
      const boards = ctx.jobBoards || [];
      const out = [];
      let ok = 0;
      for (const b of boards) {
        if (b.enabled === false) continue;
        try {
          const jobs = await fetchBoard(b);
          ok++;
          for (const j of jobs) {
            if (!JOB_WORDS.test(j.title)) continue;
            out.push({
              key: `job:${b.ats}:${b.token}:${j.id}`,
              title: `${b.company}: ${j.title}`,
              url: j.url,
              meta: { company: b.company, location: clamp(j.location || '', 60) },
            });
          }
        } catch (e) {
          console.warn(`[radar:jobs] ${b.company} (${b.ats}/${b.token}): ${e.message}`);
        }
      }
      if (boards.length && !ok) throw new Error('geen enkel vacaturebord bereikbaar');
      return out;
    },
  },
];

/** Greenhouse, Lever en Ashby hebben elk een openbare JSON-feed per bedrijf. */
async function fetchBoard(b) {
  if (b.ats === 'greenhouse') {
    const res = await getJson(`https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs`, { timeout: 20000, retries: 0 });
    return (res?.jobs || []).map((j) => ({ id: j.id, title: j.title, url: j.absolute_url, location: j.location?.name }));
  }
  if (b.ats === 'lever') {
    const res = await getJson(`https://api.lever.co/v0/postings/${b.token}?mode=json`, { timeout: 20000, retries: 0 });
    return (res || []).map((j) => ({ id: j.id, title: j.text, url: j.hostedUrl, location: j.categories?.location }));
  }
  if (b.ats === 'ashby') {
    const res = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${b.token}`, { timeout: 20000, retries: 0 });
    return (res?.jobs || []).map((j) => ({ id: j.id, title: j.title, url: j.jobUrl, location: j.location }));
  }
  throw new Error(`onbekend vacaturesysteem ${b.ats}`);
}

/** Vacatureborden: data/jobwatch.json, van de gebruiker. */
export async function loadJobBoards(file = path.join(DATA, 'jobwatch.json')) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(raw?.boards) ? raw.boards : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`${file} is corrupt (${e.message})`);
  }
}

/** Draait deze bron in dit uur? Raam: minuut 40–50 van het uur, elke N uur. */
export function isDue(src, now = new Date()) {
  if (process.env.RADAR_ALWAYS === 'true') return true;
  const m = now.getUTCMinutes();
  return m >= 40 && m < 50 && now.getUTCHours() % (src.everyHours || 1) === 0;
}

/**
 * Eén radarronde. Nieuwe items komen met de datum van vandaag in radar.json.
 *
 * Eerste keer per bron: de huidige stand is de nulmeting. Wat in de laatste
 * twee dagen ontstond telt wel als nieuw, zodat het eerste ochtendbericht niet
 * leeg is; alles daarvoor gaat stil de seen-set in.
 */
export async function runRadar(radar, { sources = SOURCES, ctx = {}, now = new Date(), extraItems = [] } = {}) {
  const due = sources.filter((s) => isDue(s, now));
  const added = [];
  const results = await Promise.allSettled(due.map(async (s) => ({ s, items: await s.fetch(ctx) })));
  const today = day(now);

  for (const [i, res] of results.entries()) {
    const s = due[i];
    if (res.status === 'rejected') {
      const prev = radar.health[s.id];
      radar.health[s.id] = { ok: false, since: prev?.ok === false ? prev.since : today };
      console.warn(`[radar:${s.id}] ${res.reason?.message || res.reason}`);
      continue;
    }
    if (radar.health[s.id]?.ok === false || !radar.health[s.id]) radar.health[s.id] = { ok: true };
    const first = !radar.seen[s.id];
    const seen = new Set(radar.seen[s.id] || []);
    for (const it of res.value.items) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      const created = it.meta?.created || it.meta?.verified || it.meta?.launched || it.meta?.starts;
      if (first && !(created && created >= day(new Date(now.getTime() - 2 * 86400000)))) continue;
      const item = { ...it, cat: s.cat, src: s.id, date: today };
      radar.items.push(item);
      added.push(item);
    }
    radar.seen[s.id] = [...seen];
    console.log(`[radar:${s.id}] ${res.value.items.length} items, ${added.filter((a) => a.src === s.id).length} nieuw${first ? ' (nulmeting)' : ''}`);
  }

  // Items die elders in de run ontstaan (contractnamen op nieuwe chains).
  for (const it of extraItems) {
    radar.seen[it.src] ||= [];
    if (radar.seen[it.src].includes(it.key)) continue;
    radar.seen[it.src].push(it.key);
    const item = { ...it, date: today };
    radar.items.push(item);
    added.push(item);
  }

  const cutoff = day(new Date(now.getTime() - KEEP_DAYS * 86400000));
  radar.items = radar.items.filter((it) => it.date >= cutoff);
  return { added, ran: due.map((s) => s.id) };
}

/** Prioriteit voor het ochtendbericht; hoger = eerst. */
export function radarScore(it) {
  let s = 0;
  if (it.cat === 'audit') s += 6;
  if (it.cat === 'contracten') s += 5;
  if (it.cat === 'vacature') s += 3;
  if (it.cat === 'bounty') s += 2;
  if (it.cat === 'techniek') {
    const hits = String(it.title).match(TECH_WORDS) || [];
    s += Math.min(4, hits.length) + (it.meta?.forum === 'ethresear.ch' ? 1 : 0);
  }
  if (it.cat === 'sdk') s += 1;
  if (it.dossier) s += 2;
  return s;
}

export const _test = { fetchBoard };
