import fs from 'node:fs/promises';
import path from 'node:path';

const DATA = process.env.CHAINWATCH_DATA || 'data';
const SEEN_DIR = path.join(DATA, 'seen');
const CHAINS_FILE = path.join(DATA, 'chains.json');
const NAMES_FILE = path.join(DATA, 'names.json');
const HEALTH_FILE = path.join(DATA, 'health.json');
const PENDING_FILE = path.join(DATA, 'pending.json');
const HEARTBEAT_FILE = path.join(DATA, 'heartbeat.json');
const BLOCKS_FILE = path.join(DATA, 'blocks.json');
const INBOXES_FILE = path.join(DATA, 'inboxes.json');

const HISTORY_LIMIT = 800;

/**
 * Leest JSON. Onderscheidt bewust "bestaat niet" (fallback, dus bootstrap) van
 * "corrupt" (gooit). Een kapot state-bestand mag NOOIT stil als bootstrap
 * doorgaan: dan zou de tool alle openstaande detecties als gezien wegschrijven
 * en de alerts voorgoed inslikken.
 */
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`kan ${file} niet lezen: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${file} is corrupt (${e.message}). Herstel het bestand of verwijder het ` +
        `en draai met --bootstrap om de baseline opnieuw vast te leggen.`
    );
  }
}

async function writeJson(file, data, compact = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomisch: nooit een half bestand achterlaten als de runner wordt afgebroken.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, compact ? 0 : 2));
  await fs.rename(tmp, file);
}

export async function loadState(sourceIds) {
  const seen = {};
  for (const id of sourceIds) {
    const arr = await readJson(path.join(SEEN_DIR, `${id}.json`), null);
    if (arr !== null && !Array.isArray(arr)) {
      throw new Error(`${SEEN_DIR}/${id}.json bevat geen array`);
    }
    seen[id] = arr === null ? null : new Set(arr); // null = nog nooit opgehaald
  }
  const names = new Set(await readJson(NAMES_FILE, []));
  const chains = await readJson(CHAINS_FILE, []);
  const health = await readJson(HEALTH_FILE, {});
  return { seen, names, chains, health };
}

export async function saveSeen(sourceId, set) {
  await writeJson(path.join(SEEN_DIR, `${sourceId}.json`), [...set].sort());
}

export async function saveNames(set) {
  await writeJson(NAMES_FILE, [...set].sort());
}

export async function saveChains(chains) {
  // Dedupliceer op key: een chain die opnieuw gedetecteerd werd na een mislukte
  // alert mag niet twee keer in de historie belanden.
  const byKey = new Map();
  for (const c of chains) {
    const existing = byKey.get(c.key);
    if (!existing || String(c.detectedAt) < String(existing.detectedAt)) byKey.set(c.key, c);
  }
  const trimmed = [...byKey.values()]
    .sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)))
    .slice(0, HISTORY_LIMIT);
  await writeJson(CHAINS_FILE, trimmed, true);
  return trimmed;
}

/** Wachtlijst van pre-launch chains waarvan we de RPC pollen. */
export async function loadPending() {
  const arr = await readJson(PENDING_FILE, []);
  if (!Array.isArray(arr)) throw new Error(`${PENDING_FILE} bevat geen array`);
  return arr;
}

export async function savePending(entries) {
  // Op key dedupliceren: een chain die via twee bronnen binnenkomt hoeft maar
  // één keer gepollt te worden.
  const byKey = new Map();
  for (const e of entries) if (e?.key) byKey.set(e.key, e);
  const sorted = [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  await writeJson(PENDING_FILE, sorted, true);
  return sorted;
}

/**
 * Hartslag: wanneer draaide de watcher voor het laatst, op het uur af.
 * Hiermee merkt de volgende run dat er een gat in de dekking zat — anders
 * staat de tool stil en denk jij dat er simpelweg geen nieuwe chains waren.
 */
export async function loadHeartbeat() {
  return readJson(HEARTBEAT_FILE, null);
}

export async function saveHeartbeat(beat) {
  await writeJson(HEARTBEAT_FILE, beat);
}

/**
 * Tot welk blok elke moederketen al afgezocht is. Zonder dit zou elke run
 * opnieuw vanaf het begin moeten scannen, en dat weigeren publieke endpoints.
 */
export async function loadBlocks() {
  const obj = await readJson(BLOCKS_FILE, {});
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${BLOCKS_FILE} bevat geen object`);
  }
  return obj;
}

export async function saveBlocks(blocks) {
  await writeJson(BLOCKS_FILE, blocks);
}

/** Sequencer-inboxen die we volgen tot hun eerste batch. */
export async function loadInboxes() {
  const arr = await readJson(INBOXES_FILE, []);
  if (!Array.isArray(arr)) throw new Error(`${INBOXES_FILE} bevat geen array`);
  return arr;
}

export async function saveInboxes(entries) {
  const byKey = new Map();
  for (const e of entries) if (e?.key) byKey.set(e.key, e);
  const sorted = [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  await writeJson(INBOXES_FILE, sorted, true);
  return sorted;
}

export async function saveHealth(health) {
  await writeJson(HEALTH_FILE, health);
}

export const paths = { DATA, SEEN_DIR, CHAINS_FILE, NAMES_FILE, HEALTH_FILE, PENDING_FILE, HEARTBEAT_FILE, BLOCKS_FILE, INBOXES_FILE };
