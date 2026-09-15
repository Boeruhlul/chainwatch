import fs from 'node:fs/promises';
import path from 'node:path';

const DATA = process.env.CHAINWATCH_DATA || 'data';
const SEEN_DIR = path.join(DATA, 'seen');
const CHAINS_FILE = path.join(DATA, 'chains.json');
const NAMES_FILE = path.join(DATA, 'names.json');
const HEALTH_FILE = path.join(DATA, 'health.json');

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

export async function saveHealth(health) {
  await writeJson(HEALTH_FILE, health);
}

export const paths = { DATA, SEEN_DIR, CHAINS_FILE, NAMES_FILE, HEALTH_FILE };
