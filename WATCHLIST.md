# Watchlist: bekende projecten tot hun mainnet volgen

Sommige projecten vallen tussen wal en schip juist omdat ze al bekend zijn. GIWA, Ritual of Rialo draaien al maanden als testnet en staan dus in elke bron; een chain-ID-aanvraag voor de mainnet heet dan een cross-listing en gaat stil voorbij. Vaak draait de mainnet bovendien eerst besloten, zodat er ook niets te registreren valt.

Daarvoor is `data/watchlist.json`. Dat bestand is van jou: zet er projecten in die je gericht wilt volgen. De bot schrijft alleen in `data/watch-state.json`, zodat een handmatige wijziging nooit botst met de state-commit van de workflow.

## Drie signalen per project

| Signaal | Hoe | Bericht |
|---|---|---|
| **Naam of domein** | Elke detectie uit élke bron die op een alias matcht, of een RPC/explorer/website op een projectdomein heeft | Gaat altijd door, ook als cross-listing, met 👀 *Op je watchlist* en +25 prioriteit. Eén keer per fase: komt de mainnet daarna via zes andere registers binnen, dan is dat geen nieuws meer. Testnets en devnets volgen de gewone regels. |
| **Kandidaat-RPC** | De URL's onder `rpc` krijgen elke run `eth_chainId`. Een chain ID dat niet in `knownChainIds` staat is een nieuwe chain van dit team | 👀 *nieuwe chain van dit team, RPC antwoordt* — prioriteit 97 |
| **Projectdomein** | Certificate Transparency (crt.sh) op `%.domein`, één domein per run roulerend. De eerste keer wordt de hele historie als baseline vastgelegd | Nieuw certificaat voor `rpc.`, `mainnet.`, `explorer.`, `bridge.` e.d. → 👀 *nieuw subdomein*. Test-infra (`sepolia-`, `dev-`, `staging.`) wordt stil vastgelegd. Antwoordt het nieuwe subdomein met een onbekend chain ID, dan wordt het meteen het RPC-bericht. |

Gokken in `rpc` mag: wat niet bestaat antwoordt niet. De testnet-RPC zelf erin zetten is ook zinvol — schakelt het team die URL om naar de mainnet, dan verandert het chain ID en krijg je een bericht.

Een alert die niet aankomt telt niet als gezien en komt de volgende run terug, zoals overal in de tool. Bij `--bootstrap` legt de watchlist alleen vast wat er nu is, zonder te melden.

## Afstellen

Optioneel, via repository-variabelen (en dan doorgeven in `watch.yml`) of lokaal als env:

| Variabele | Standaard | Wat |
|---|---|---|
| `WATCH_ENABLED` | `true` | `false` zet de watchlist uit |
| `WATCH_BUDGET_SECONDS` | `30` | Tijdsbudget per run voor RPC's en crt.sh |
| `WATCH_CT_PER_RUN` | `1` | Aantal projectdomeinen per run in crt.sh |

## Een project toevoegen

```json
{
  "id": "naam",
  "name": "Naam",
  "aliases": ["naam"],
  "ecosystem": "EVM",
  "website": "https://naam.xyz",
  "domains": ["naam.xyz"],
  "knownChainIds": [12345],
  "rpc": ["https://rpc.naam.xyz"],
  "note": "waarom je dit volgt"
}
```

`enabled: false` zet een project tijdelijk uit. Een project van de lijst halen ruimt ook zijn state op.
