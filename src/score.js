/**
 * Prioriteit van een detectie, 0-100.
 *
 * Het doel is NIET filteren — alles wordt nog steeds gestuurd — maar sorteren
 * en labelen, zodat een chain-ID-aanvraag met een domein van vijf dagen oud
 * bovenaan staat en een cross-listing van een bekende chain onderaan.
 */

/** Bronnen die per definitie vroeg zijn: registratie of integratie vóór launch. */
const EARLY_SOURCES = new Set([
  'ethlists-pr', 'ethlists-commit', 'superchain', 'viem', 'keplr-pr', 'l2beat', 'cosmos',
  'rollup-factory', 'ct-hostnames', 'blob-submitters',
]);

const BASE_BY_KIND = {
  // Een chain die draait zonder aankondiging is het zeldzaamste en waardevolste
  // dat deze tool kan vinden, dus die begint hoog.
  stealth: 58,
  proposal: 40,
  upcoming: 38,
  mainnet: 28,
  testnet: 20,
  devnet: 12,
};

export function scoreChain(c) {
  const reasons = [];
  let s = BASE_BY_KIND[c.kind] ?? 10;
  if (c.kind === 'proposal' || c.kind === 'upcoming') reasons.push('pre-launch');

  if (c.kind === 'stealth') {
    reasons.push(
      {
        hostname: 'RPC antwoordt, nergens aangekondigd',
        factory: 'contract uitgerold op de moederketen',
        blob: 'post blobs zonder bekende naam',
      }[c.stealthKind] || 'niet aangekondigd'
    );
    // Een chain ID erbij betekent dat we hem echt hebben aangesproken.
    if (c.chainId != null) s += 8;
  }

  if (EARLY_SOURCES.has(c.source)) s += 12;

  // Een project dat je al als testnet of aankondiging kende en nu live gaat,
  // is het interessantste reguliere signaal dat er is: je weet al wie het is,
  // en dit is het moment waarop het begint.
  if (c.promotedFrom) {
    s += 22;
    reasons.push(c.promotedFrom === 'testnet' ? 'was al testnet' : 'was aangekondigd');
  }

  const age = c.domain?.ageDays;
  if (typeof age === 'number') {
    if (age <= 30) { s += 24; reasons.push(`domein ${age}d oud`); }
    else if (age <= 120) { s += 13; reasons.push(`domein ${Math.round(age / 30)}mnd oud`); }
    else if (age > 900) { s -= 6; }
  }

  const gh = c.github?.ageDays;
  if (typeof gh === 'number' && gh <= 120) { s += 9; reasons.push('nieuwe GitHub-org'); }

  // Een faucet of testnet-naam zonder enig ander signaal is meestal ruis.
  if (c.kind === 'testnet' && !c.domain && !c.socials) s -= 5;

  // Al ergens anders gezien: dan is de kans dat je de eerste bent klein.
  if (c.crossListing) { s -= 26; reasons.push('al bekend via andere bron'); }

  // Grote TVL betekent dat de chain al draait en gevonden is.
  if (typeof c.tvl === 'number' && c.tvl > 1e6) { s -= 10; reasons.push('heeft al TVL'); }

  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

export function badgeFor(score) {
  if (score >= 62) return { icon: '🔥', label: 'HOOG' };
  if (score >= 38) return { icon: '⭐', label: 'MIDDEL' };
  return { icon: 'ℹ️', label: 'LAAG' };
}
