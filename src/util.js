import { createHash } from 'node:crypto';

/** Slug voor cross-bron deduplicatie: alleen letters/cijfers, lowercase. */
export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

const TESTNET_RE = /\b(testnet|test net|sepolia|goerli|holesky|hoodi|devnet|dev net|staging|sandbox|faucet|preview|prealpha|pre-alpha|alphanet|betanet|incentivized)\b/i;
const DEVNET_RE = /\b(devnet|dev net|localnet|sandbox)\b/i;

/** mainnet | testnet | devnet — op naam + signalen. */
export function classify(name, { faucets = [], explicit } = {}) {
  if (explicit) return explicit;
  const n = String(name || '');
  if (DEVNET_RE.test(n)) return 'devnet';
  if (TESTNET_RE.test(n)) return 'testnet';
  // Een chain met faucet maar zonder testnet in de naam is vrijwel altijd een testnet.
  if (Array.isArray(faucets) && faucets.length > 0) return 'testnet';
  return 'mainnet';
}

/**
 * Bucket voor dedupe. Cruciaal: 'pre' staat los van 'main'.
 * Een project dat we eerst als pre-launch signaal zagen (L2BEAT-tracking of een
 * chain-ID aanvraag) MOET opnieuw alerten zodra hij daadwerkelijk live gaat —
 * dat is het interessantste moment. Zaten pre-launch en mainnet in dezelfde
 * bucket, dan zou de launch als duplicaat worden weggefilterd.
 */
function bucketFor(kind) {
  if (kind === 'upcoming' || kind === 'proposal') return 'pre';
  if (kind === 'mainnet') return 'main';
  return 'test';
}

/** Sleutel voor cross-bron dedupe binnen dezelfde levensfase. */
export function nameKey(name, kind) {
  // Alleen classificatie-woorden strippen. 'network'/'protocol' NIET:
  // "Oasis Network" en "Oasis Protocol" zijn verschillende projecten.
  const base = slug(name).replace(/(testnet|devnet|localnet|mainnet)+$/, '') || slug(name);
  // Namen zonder ASCII-tekens (CJK, emoji) worden leeg; dan een hash i.p.v.
  // een gedeelde lege sleutel waar alles op zou botsen.
  const id = base || `h${createHash('sha1').update(String(name || '')).digest('hex').slice(0, 10)}`;
  return `${id}:${bucketFor(kind)}`;
}

export function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Tijdstempel afgerond naar beneden op het hele uur.
 *
 * Bestaat om commit-ruis te voorkomen: elk veld in de state dat bij elke run
 * verandert dwingt de workflow tot een commit, ook als er niets gebeurd is.
 * Bij een poll elke 5 minuten zou dat ~288 commits per dag zijn. Op het uur
 * afgerond zijn het er hoogstens 24, en voor "wanneer draaide dit voor het
 * laatst" is een uur nauwkeurig genoeg.
 */
export function hourIso(d = new Date()) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t.toISOString();
}

/** Kapt een string af op een woordgrens; houdt Telegram-berichten binnen de limiet. */
export function clamp(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
