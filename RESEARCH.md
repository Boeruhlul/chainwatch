# Deep research → chainwatch

Een wekelijkse geplande Claude-sessie doet breed onderzoek naar nieuwe chains en schrijft haar vondsten naar `data/research/<YYYY-MM-DD>-<label>.json`. De `research`-bron leest die bestanden bij de volgende run in.

- Elke kandidaat komt in een dossier en wordt daar gekoppeld aan wat de bot zelf al zag.
- Per bestand gaat er één overzichtsbericht (`🔎 DEEP RESEARCH`) naar Telegram.

De sessie heeft dus geen Telegram-token nodig; alles loopt via dezelfde pijplijn, dedupe en kanaal.

## Formaat

Een JSON-array. Per kandidaat:

```json
{
  "name": "Projectnaam",
  "aliases": ["codenaam"],
  "org": "organisatie",
  "architecture": "EVM L2 · OP Stack",
  "stage": "rumor | development | devnet | testnet | private-mainnet | mainnet",
  "confidence": "A | B | C | D",
  "why": "1-2 zinnen: waarom interessant, wat is er vroeg aan",
  "facts": [{ "claim": "wat een bron letterlijk zegt", "url": "https://…", "date": "2026-10-01" }],
  "hypotheses": ["expliciet speculatief"],
  "chainIds": [12345],
  "website": "https://…",
  "rpc": ["https://… (alleen als publiek gedocumenteerd)"],
  "explorer": "https://…",
  "ecosystem": { "dex": "…", "launchpad": "…", "bridge": "…" },
  "expectedLaunch": "Q1 2027 (alleen met bron in facts)",
  "nextSignals": ["waar op te letten"]
}
```

Regels:

- Feiten en hypothesen strikt gescheiden houden.
- Nooit URL's, chain ID's of datums verzinnen.
- Onbekende velden weglaten in plaats van invullen.
- Een onleesbaar bestand wordt overgeslagen en gelogd; de rest gaat gewoon door.

Een kandidaat die volgende week opnieuw in een nieuw bestand staat, wordt opnieuw gemeld als onderdeel van dat overzicht. Daarbij staat dan "ook uit eigen bronnen bekend" als de bot hem zelf al had gezien.
