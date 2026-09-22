# chainwatch

Detecteert nieuwe crypto-netwerken — mainnet, testnet, devnet en pre-launch — en stuurt een Telegram-alert zodra er eentje opduikt. Draait gratis op GitHub Actions, geen server nodig.

## Wat het volgt

| Bron | Wat je ermee vangt | Hoe vroeg |
|---|---|---|
| **ethereum-lists open PRs** | Een team registreert zijn EVM chain ID | Dagen tot weken vóór launch |
| **ethereum-lists commits** | Het moment dat die registratie gemerged wordt | Vóór chainid.network opnieuw gebouwd is |
| **Keplr chain-registry PRs** | Het Cosmos-equivalent: chains die nooit een EVM chain ID aanvragen | Rond genesis |
| **Superchain registry** | Elke OP Stack rollup, inclusief `sepolia/`-varianten | Vaak weken vóór mainnet |
| **viem chain-definities** | Ontwikkelaarssignaal: iemand bouwt ergens tegenaan | Zodra er code voor bestaat |
| **L2BEAT config-repo** | Nieuw rollup/L2-project in tracking | Vaak vóór mainnet |
| **Cosmos chain-registry** | Cosmos SDK chains, incl. `testnets/` en `devnets/` | Bij genesis-readiness |
| **Chainlist** (chainid.network) | Elke EVM chain, mainnet + testnet, met RPC's en faucets | Bij registratie |
| **Hyperlane registry** | Chains waar de interop-laag op uitgerold is, ook non-EVM | Rond deploy |
| **Blockscout** | Netwerken die een explorer neerzetten — met `website`-veld | Vaak vóór registratie |
| **Avalanche Glacier** | L1's en subnets die nergens anders systematisch staan | Bij deploy |
| **LI.FI** | Chains zodra er liquiditeit en een brug is | Bij bruikbaarheid |
| **DefiLlama** | Non-EVM chains zodra er TVL op staat | Bij eerste protocol |
| **CoinGecko asset platforms** | L1's zodra er tokens genoteerd worden | Later, goede kruiscontrole |

De eerste twee zijn de reden dat je er vroeg bij bent; de rest is dekking en bevestiging.

## Setup

### 1. Telegram-bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → je krijgt een **token**.
2. Stuur je nieuwe bot een berichtje (anders mag hij je niet DM'en).
3. Chat ID ophalen: `https://api.telegram.org/bot<TOKEN>/getUpdates` → pak `result[0].message.chat.id`.

### 2. Secrets

**Settings → Secrets and variables → Actions → Secrets:**

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

`GITHUB_TOKEN` hoef je niet te zetten, die geeft Actions zelf mee.

### 3. Baseline vastleggen

**Actions → chainwatch → Run workflow → bootstrap: true**

Dit slaat de ~4.000 bestaande chains op zónder je te spammen. Vanaf dat moment is alles wat erbij komt een alert. **Sla deze stap niet over** — zonder baseline krijg je bij de eerste gewone run duizenden berichten, of erger: de anomalie-rem slikt ze in als één samenvatting.

### 4. Dashboard (optioneel)

**Settings → Pages → Source: Deploy from a branch → main / `/docs`.**

## Waarom public

Actions zijn gratis en onbeperkt voor public repo's. Private repo's op een gratis account hebben 2.000 minuten per maand; bij een run elke 5 minuten is dat binnen anderhalve week op en valt de tool stil. GitHub Pages voor het dashboard vereist bij private bovendien een betaald plan.

Je secrets liggen hier niet gevoelig: Actions-secrets zijn versleuteld, staan niet in de repo en zijn ook bij een public repo niet zichtbaar. Zet ze daarom nooit in een bestand.

## Afstellen

Onder **Settings → Secrets and variables → Actions → Variables**:

| Variable | Default | Effect |
|---|---|---|
| `WATCH_KINDS` | `mainnet,testnet,devnet,upcoming,proposal` | Haal `proposal` weg als PR-ruis te veel is |
| `NOTIFY_CROSS_LISTING` | `false` | `true` = ook alerten als een bekende chain op een nieuwe bron verschijnt |
| `DISABLED_SOURCES` | leeg | Bv. `coingecko,defillama` |
| `MAX_ALERTS_PER_RUN` | `25` | Daarboven één samenvatting i.p.v. losse berichten |
| `ENRICH_SOCIALS` | `true` | `false` zet het opzoeken van socials en domeinleeftijd uit |
| `ENRICH_LIMIT` | `12` | Aantal chains per run dat verrijkt wordt, hoogste prioriteit eerst |
| `ENRICH_BUDGET_SECONDS` | `150` | Harde tijdslimiet voor alle verrijking samen |

## Lokaal draaien

```bash
cp .env.example .env    # vul token en chat ID in
node --env-file=.env src/index.js --bootstrap   # eenmalig
node --env-file=.env src/index.js               # daarna
node --env-file=.env src/index.js --dry-run     # tonen zonder versturen of opslaan
node test/run.js                                # 23 tests, geen netwerk nodig
```

## Hoe snel is het echt

GitHub Actions cron is **een bovengrens, geen garantie** — onder belasting wordt een run uitgesteld, in de praktijk 5–20 minuten. Voor de meeste launches ruim genoeg, want via PR's en L2BEAT zie je ze toch al dagen eerder.

Wil je écht seconden, dan draait dezelfde code als daemon op een VPS:

```bash
while true; do node src/index.js; sleep 30; done
```

Zet `CHAINWATCH_DATA` naar een persistente map — verder verandert er niets aan de code.

## Hoe het werkt

Elke bron levert genormaliseerde records met een stabiele `key`. Per bron staat in `data/seen/<bron>.json` welke keys al gezien zijn; wat daar niet in staat is nieuw.

De hele opzet is gebouwd rond één vraag: *wanneer zou dit een chain kunnen missen?* Een gemiste launch weegt veel zwaarder dan een alert te veel, dus elke twijfelachtige stap kiest de kant van "toch melden".

- **Een alert die niet aankwam telt niet als gezien.** Faalt Telegram halverwege, dan blijven precies die chains buiten de state en worden ze de volgende run opnieuw geprobeerd. De al verstuurde alerts komen níét dubbel. Daarom commit de workflow de state ook met `if: always()`.
- **Een kapotte bron raakt de state niet aan.** Mislukt een fetch, dan wordt die `seen`-set niet bijgewerkt. `seen` is append-only: er verdwijnt nooit iets uit.
- **Corrupte state faalt hard.** Een half geschreven `seen`-bestand wordt níét als "nog nooit gedraaid" opgevat — dat zou stilletjes alle openstaande detecties als gezien wegschrijven. Je krijgt een Telegram-waarschuwing en de run stopt.
- **Pre-launch en live zijn aparte gebeurtenissen.** Een project dat je via L2BEAT of een chain-ID-aanvraag al zag, alerteert opnieuw zodra het echt live gaat. Dat is meestal het moment waar het je om gaat.
- **Anomalie-rem, per bron.** Levert één bron ineens meer dan 2× `MAX_ALERTS_PER_RUN` nieuwe keys, dan is waarschijnlijk het formaat veranderd; je krijgt één samenvatting voor díé bron. Andere bronnen blijven gewoon losse, volledige alerts sturen.
- **Cross-bron dedupe.** Een chain die binnen dezelfde levensfase al via een andere bron bekend is krijgt `crossListing: true` en wordt standaard onderdrukt — anders alert je zes keer over dezelfde chain.
- **Bronfouten hebben een stilteperiode van 6 uur.** Anders levert een API-outage in het weekend honderden identieke berichten op waarin echte alerts verdrinken.
- **Faucets en RPC's zitten in de alert**, zodat je direct kunt handelen zonder eerst te gaan zoeken.

De PR-bron filtert bewust niet op titel. PR-titels zijn te divers (`Add Lisk Sepolia`, `feat: add Monad`, `Foobar chain addition`) en een regex laat er gegarandeerd doorheen glippen. In plaats daarvan wordt elke open PR meegenomen en via de files-API bevestigd of er echt een `_data/chains/*.json` bij zit — alleen voor PR's die nog niet gezien zijn, dus na de bootstrap een handvol per run.

## Verrijking: socials en "zijn we vroeg"

Een chain-ID-aanvraag geeft je een naam, een ID en een RPC — te weinig om iets mee te doen. Daarom zoekt de tool er zelf omheen:

1. **Website afleiden.** Uit `infoURL` (ethereum-lists), het `website`-veld (Blockscout), of anders het registreerbare domein achter de explorer of de RPC. Infra-domeinen (`blockscout.com`, `llamarpc.com`, `vercel.app`, …) vallen af, want dat is nooit de site van het project zelf.
2. **Socials uit de homepage.** X, Telegram, Discord, GitHub en docs. Bewust regex op de hele broncode en niet alleen op `<a href>`: veel chain-sites zijn SPA's waar de links pas in een JS-bundel staan. Bij meerdere kandidaten wint de handle die het vaakst voorkomt — navigatie staat in header én footer, een toevallige link maar één keer.
3. **Domeinleeftijd via RDAP.** Gratis, geen sleutel, en het sterkste "ben ik vroeg"-signaal dat er is: een chain met een domein van elf dagen oud is nog nergens rondgegaan.
4. **Leeftijd van de GitHub-org** achter de gevonden repo-link.

Alles is best-effort en zit achter een harde tijdslimiet: verrijking mag nooit een detectie tegenhouden of de run van twaalf minuten opeten. Een chain zonder vindbare socials is nog steeds een alert.

## Prioriteit

Elke detectie krijgt een score van 0 tot 100 (`src/score.js`) die het bericht labelt met 🔥, ⭐ of ℹ️. Er wordt niets weggefilterd — de score bepaalt alleen de volgorde en het label, en gaat in het bericht mee met de reden erbij.

Wat telt: pre-launch weegt zwaarder dan live, een bron die van nature vroeg is telt mee, een vers domein of een nieuwe GitHub-org geeft een flinke plus, en een chain die al via een andere bron bekend was of al TVL heeft zakt. De verrijkingsbudget gaat naar de hoogste prioriteiten eerst.

## Structuur

```
src/
  index.js        orchestratie, diff, filtering, anomaliedetectie
  sources/        één adapter per bron, elk faalt onafhankelijk
  store.js        append-only state, atomische writes
  notify.js       Telegram-formatting en rate limiting
  dashboard.js    genereert docs/index.html
  enrich.js       socials, domeinleeftijd (RDAP), GitHub-org — best-effort
  score.js        prioriteit 0-100 per detectie
data/
  seen/*.json     gezien-keys per bron (git-vriendelijke gesorteerde arrays)
  names.json      cross-bron dedupe-sleutels
  chains.json     laatste 800 detecties met volledige details
  health.json     status per bron + stilteperiode voor foutmeldingen
```

## Een bron toevoegen

Maak `src/sources/jouwbron.js` met een default export `{ id, label, url, fetchAll() }`. `fetchAll` geeft records terug met minimaal `key`, `name`, `nameKey`, `kind`, `source`, `url`. Registreer hem in `src/sources/index.js`. De rest — diffing, dedupe, alerting, dashboard — werkt automatisch.

Optioneel kun je een `enrich(nieuweRecords)` meegeven. Die wordt alleen aangeroepen voor records die nog niet gezien zijn, handig als per item een extra API-call nodig is. Records die `enrich` weglaat komen niet in de alerts maar tellen wél als gezien.

Het dashboard bevat bewust geen "laatste run"-tijdstempel. Zou die er staan, dan verschilt het bestand bij elke run en commit de workflow ~288 keer per dag zonder dat er iets gebeurd is.
