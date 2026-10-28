import { gh } from '../http.js';
import { slug } from '../util.js';

/**
 * GitHub-discovery: verse repo's van onbekende teams met een chainconfig erin.
 *
 * De registers zien een chain pas als het team zich aanmeldt. Wat daaraan
 * voorafgaat staat vaak gewoon op GitHub: een nieuwe repo met een genesis-
 * bestand, een rollup.json, een OP-deploy-config of een Orbit-nodeconfig.
 *
 * Twee stappen, zodat de ruis betaalbaar blijft:
 *   1. fetchAll: repo-search op repo's van de afgelopen dagen met chainwoorden
 *      in naam, omschrijving of README. Dat levert vooral tutorials op.
 *   2. enrich (alleen voor nieuwe repo's): één tree-call per repo. Alleen wat
 *      echt een chainconfig bevat blijft over; de rest verdwijnt stil.
 *
 * Draait één keer per uur (shouldRun), niet elke run: de search-API heeft een
 * eigen, krappe limiet en verse repo's lopen niet weg.
 *
 * Levert 'lead'-records: die geven geen directe alert maar komen in een
 * dossier en het dagoverzicht. Pas als een tweede, onafhankelijke bron
 * hetzelfde project raakt (zelfde GitHub-org, domein of chain ID) wordt het
 * een melding — dat doet de dossierlaag.
 */

const WINDOW_DAYS = Number(process.env.GH_DISCOVERY_DAYS || 3);
const PER_QUERY = 30;

export const QUERIES = [
  'testnet in:name,description',
  'mainnet in:name,description',
  'rollup in:name,description',
  'devnet in:name,description',
  '"op-stack" OR "op-geth" OR "op-node" in:readme,description',
  'orbit nitro in:readme',
  'cometbft OR "cosmos-sdk" in:readme,description',
  'genesis chain in:name,description',
  '"layer 1" OR "layer 2" OR appchain OR l2 in:description',
];

/** Paden die verraden dat iemand een eigen chain opzet. */
export const CONFIG_PATTERNS = [
  [/(^|\/)genesis[\w.-]*\.json$/i, 'genesis'],
  [/(^|\/)rollup[\w.-]*\.json$/i, 'OP rollup-config'],
  [/(^|\/)chainspec[\w.-]*\.json$/i, 'chainspec'],
  [/(^|\/)deploy-config\/[\w.-]+\.json$/i, 'OP deploy-config'],
  [/(^|\/)(intent|state)\.toml$/i, 'op-deployer'],
  [/(^|\/)(nodeConfig|orbitSetupScriptConfig|l2_chain_info)\.json$/i, 'Arbitrum Orbit'],
  [/(^|\/)chain\.json$/i, 'Cosmos chain.json'],
  [/(^|\/)config\/genesis\.json$/i, 'Cosmos genesis'],
  [/(^|\/)(zksync|zk_chain|chain_config)[\w.-]*\.(ya?ml|json|toml)$/i, 'ZK Stack'],
];

/** Repo's die vrijwel altijd oefenmateriaal of tools zijn, geen chain. */
const JUNK = /(tutorial|course|learn|lesson|bootcamp|hackathon|homework|assignment|workshop|example|template|starter|boilerplate|sniper|bot\b|airdrop|faucet-?claim|auto-?claim|farm|clone|copy|interview|test-?task|practice|portfolio|dapp-?ui|frontend|wallet-?drainer|drainer)/i;

export function isJunk(repo) {
  return Boolean(JUNK.test(`${repo.name} ${repo.description || ''}`) || repo.fork || repo.archived);
}

export function configHits(paths) {
  const hits = [];
  for (const p of paths) {
    if (/node_modules|(^|\/)(tests?|fixtures?|examples?|mocks?)\//i.test(p)) continue;
    for (const [re, label] of CONFIG_PATTERNS) {
      if (re.test(p)) { hits.push({ path: p, label }); break; }
    }
  }
  return hits.slice(0, 8);
}

/** Uur-raam: alleen in de eerste tien minuten van het uur. */
export function inSlot(now = new Date()) {
  return now.getUTCMinutes() < 10;
}

/** Bekende netwerken: een repo die "Stellar testnet" noemt is geen nieuws. */
const KNOWN_NETS = new Set(`stellar near arbitrum base sepolia solana ethereum polygon avalanche sui aptos monad
hyperliquid zcash bnb bsc ton tron cardano bitcoin cosmos celestia optimism starknet scroll linea mantle
berachain story movement algorand hedera polkadot kusama fuel injective sei somnia megaeth holesky hoodi
goerli amoy fuji local the a an your my our public private ganache hardhat anvil foundry localhost robinhood
xrpl xrp ripple flow tezos kaspa filecoin icp internet computer mina aleo aztec zksync blast mode zora ink
unichain soneium plume abstract taiko celo gnosis kava osmosis neutron stacks rootstock core flare sonic
fantom cronos klaytn kaia oasis moonbeam astar harmony iota etherlink lisk metis boba manta zkevm`.split(/\s+/));

/**
 * Netwerknamen die in een omschrijving genoemd worden: "Testnet GPU mining
 * on Tidepool Testnet". Een onbekende naam is een aanwijzing dat er iets
 * bestaat waar wij nog geen register van hebben. Eén record per naam, ooit.
 */
export function mentionedNetworks(text) {
  const out = new Set();
  const re = /\b([A-Z][A-Za-z0-9]{2,20}(?:[ -][A-Z][A-Za-z0-9]{1,20})?)(?:\s+Chain)?\s+(Testnet|Devnet|Mainnet)\b/g;
  for (const m of String(text || '').matchAll(re)) {
    const name = m[1].trim();
    const first = name.split(/[ -]/)[0].toLowerCase();
    if (KNOWN_NETS.has(first) || KNOWN_NETS.has(name.toLowerCase())) continue;
    out.add(name);
  }
  return [...out];
}

function toRecord(repo) {
  const owner = repo.owner?.login || repo.full_name.split('/')[0];
  return {
    key: `ghrepo:${repo.full_name.toLowerCase()}`,
    source: 'github-discovery',
    name: repo.full_name,
    nameKey: `${slug(repo.full_name)}:lead`,
    noNameKey: true,
    githubOrg: owner,
    kind: 'lead',
    leadKind: 'github-config',
    ecosystem: 'onbekend',
    chainId: null,
    rpc: [], explorers: [], faucets: [],
    website: repo.homepage || null,
    description: repo.description || null,
    url: repo.html_url,
    ownerType: repo.owner?.type || null,
    repoCreatedAt: repo.created_at,
    branch: repo.default_branch || 'HEAD',
  };
}

export default {
  id: 'github-discovery',
  label: 'GitHub: verse repo\'s met chainconfig',
  url: 'https://github.com/search',
  shouldRun: () => process.env.GH_DISCOVERY !== 'false' && (process.env.GH_DISCOVERY_ALWAYS === 'true' || inSlot()),

  async fetchAll() {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const byName = new Map();
    let ok = 0;
    let lastErr;
    for (const q of QUERIES) {
      try {
        const res = await gh(`/search/repositories?q=${encodeURIComponent(`${q} created:>=${since} fork:false`)}&sort=updated&order=desc&per_page=${PER_QUERY}`, { retries: 1 });
        ok++;
        for (const repo of res?.items || []) {
          if (!repo?.full_name || isJunk(repo)) continue;
          byName.set(repo.full_name.toLowerCase(), repo);
        }
      } catch (e) {
        lastErr = e;
      }
    }
    // Eén mislukte query is geen bronfout; allemaal mislukt wel.
    if (!ok) throw lastErr || new Error('alle zoekopdrachten mislukt');
    const records = [...byName.values()].map(toRecord);
    // Tweede oogst uit dezelfde zoekresultaten: genoemde, onbekende netwerken.
    const names = new Map();
    for (const repo of byName.values()) {
      for (const n of mentionedNetworks(repo.description)) {
        const k = slug(n);
        if (k.length >= 3 && !names.has(k)) names.set(k, { n, repo });
      }
    }
    for (const [k, { n, repo }] of names) {
      records.push({
        key: `ghname:${k}`,
        source: 'github-discovery',
        name: n,
        nameKey: `${k}:lead`,
        kind: 'lead',
        leadKind: 'naam-in-repo',
        ecosystem: 'onbekend',
        chainId: null,
        rpc: [], explorers: [], faucets: [],
        description: `genoemd in ${repo.full_name}: ${repo.description || ''}`.slice(0, 300),
        url: repo.html_url,
      });
    }
    return records;
  },

  /** Alleen nieuwe repo's: bevat hij echt een chainconfig? */
  async enrich(fresh) {
    const out = fresh.filter((r) => r.leadKind === 'naam-in-repo');
    for (const r of fresh.filter((x) => x.leadKind === 'github-config').slice(0, 40)) {
      try {
        const tree = await gh(`/repos/${r.name}/git/trees/${encodeURIComponent(r.branch)}?recursive=1`, { retries: 0, timeout: 15000 });
        const hits = configHits((tree?.tree || []).filter((t) => t.type === 'blob').map((t) => t.path));
        if (!hits.length) continue;
        const labels = [...new Set(hits.map((h) => h.label))];
        out.push({
          ...r,
          configFiles: hits.map((h) => h.path),
          ecosystem: labels.join(', '),
          description: [r.description, `configs: ${hits.map((h) => h.path).slice(0, 4).join(', ')}`].filter(Boolean).join(' — '),
        });
      } catch { /* lege repo of geen toegang: overslaan */ }
    }
    return out;
  },
};
