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
| `PROBE_ENABLED` | `true` | `false` zet de wachtlijst en het RPC-pollen uit |
| `PROBE_LIMIT` | `40` | Max. wachtlijst-items dat per run gepollt wordt |
| `PROBE_BUDGET_SECONDS` | `60` | Harde tijdslimiet voor al het pollen samen |
| `PROBE_TTL_DAYS` | `120` | Daarna valt een item van de wachtlijst, zonder bericht |
| `INBOX_LIMIT` | `40` | Sequencer-inboxen die per run gepollt worden |
| `INBOX_BUDGET_SECONDS` | `45` | Tijdslimiet voor het pollen van inboxen |
| `INBOX_TTL_DAYS` | `180` | Daarna stoppen we met wachten op een eerste batch |
| `STALE_ALERT_HOURS` | `3` | Waarschuw als de vorige run langer dan dit geleden was |
| `CT_PATTERNS` | zeven patronen | Waar in Certificate Transparency op gezocht wordt |
| `BLOB_MIN_TXS` | `3` | Zoveel batches moet een naamloos adres posten voordat het telt |
| `BLOB_PAGE_SIZE` | `100` | Hoeveel blob-transacties per run opgehaald worden |
| `EVM_RPC_ETHEREUM` | publieke endpoints | Komma-gescheiden eigen RPC's, bv. een Alchemy-sleutel |
| `EVM_RPC_ARBITRUM` | publieke endpoints | Idem voor Arbitrum One |
| `EVM_RPC_BASE` | publieke endpoints | Idem voor Base |

## Lokaal draaien

```bash
cp .env.example .env    # vul token en chat ID in
node --env-file=.env src/index.js --bootstrap   # eenmalig
node --env-file=.env src/index.js               # daarna
node --env-file=.env src/index.js --dry-run     # tonen zonder versturen of opslaan
node test/run.js                                # 23 tests, geen netwerk nodig
```

## Naar een Telegram-kanaal

`TELEGRAM_CHAT_ID` mag ook een kanaal zijn in plaats van een persoonlijke chat.
Zet de bot als **administrator** in het kanaal met het recht om berichten te
plaatsen, en vul dan in:

- publiek kanaal: `@kanaalnaam` — verder niets nodig
- privékanaal: het numerieke ID, dat begint met `-100`

Zet in dat geval ook `TELEGRAM_ADMIN_CHAT_ID` op je eigen chat-ID. Storingen —
falende bronnen, dekkingsgaten, crashes — gaan dan naar jou en niet naar het
kanaal. Lezers hebben niets aan "bron coingecko faalt", en jij wilt het juist
wél weten. Laat je hem leeg, dan gaat alles naar dezelfde bestemming; dat is
het oude gedrag.

## Echt elke 5 minuten draaien

`watch.yml` staat op `*/5`, maar **GitHub voert dat niet uit.** Gemeten op deze
repo in september 2026: de workflow draaide in de praktijk elke 3 tot 5 uur —
40 runs in een week waar er ~2.000 hadden moeten staan. Dat is bekend gedrag.
GitHub knijpt `schedule`-triggers af op repo's met weinig activiteit en slaat
ze soms helemaal over.

Daarmee is de cron de traagste schakel in de hele keten: het heeft weinig zin
om bronnen te gebruiken die dagen eerder zijn als er aan het eind vier uur
wachttijd bij komt.

`workflow_dispatch` heeft die beperking niet. In [`tools/pinger`](tools/pinger)
staat een Cloudflare Worker van tien regels die dat elke 5 minuten aanroept,
met de opzetstappen en het token dat je ervoor nodig hebt. Elke cron-dienst die
een POST kan doen werkt ook; dat staat er ook bij. De `concurrency`-groep in de
workflow zorgt dat een trigger tijdens een lopende run gewoon wacht in plaats
van een dubbele run op te leveren.

De `schedule`-trigger blijft staan als vangnet voor als de pinger zelf uitvalt.

**Je merkt het nu ook als het misgaat.** Elke run legt in `data/heartbeat.json`
vast wanneer hij draaide, afgerond op het uur. Zat er meer dan
`STALE_ALERT_HOURS` tussen twee runs, dan krijg je daar een Telegram-bericht
over. Zonder die check ziet stilstand eruit als "er waren geen nieuwe chains",
en dat is precies het soort storing dat je maanden niet opmerkt.

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

## Stealth: chains die draaien zonder aankondiging

De registerbronnen hierboven vinden een chain pas als iemand hem ergens
aanmeldt. Maar een chain kan maandenlang draaien zonder dat er een woord over
gezegd is — Robinhood Chain deed precies dat. Die was te vinden door
`rpc.mainnet.chain.robinhood.com` simpelweg om zijn chain ID te vragen; hij
antwoordde, met duizenden transacties al verwerkt.

Drie bronnen dekken dat af, en ze vullen elkaar aan.

**`ct-hostnames`** — elk TLS-certificaat wordt publiek gelogd. Zet een team een
sequencer of publieke RPC in de lucht, dan staat die hostnaam binnen minuten in
Certificate Transparency, ook zonder aankondiging. We zoeken op smalle patronen
(`rpc.mainnet.%`, `sequencer.%`, …) en kloppen bij elke nieuwe hostnaam aan met
`eth_chainId`. De ruis lost zichzelf op: wie niet antwoordt verdwijnt stil, wie
wel antwoordt *is* een draaiende chain. Instelbaar met `CT_PATTERNS`.

**`rollup-factory`** — een Arbitrum-chain kan niet bestaan zonder via het
fabriekscontract op zijn moederketen te worden aangemaakt, en dat laat een
openbaar logbericht achter. Stil uitrollen verandert daar niets aan. We lezen
de fabrieken op Ethereum, Arbitrum One en Base en halen waar mogelijk het chain
ID op bij het nieuwe rollup-contract. Er wordt bewust niet op de handtekening
van de gebeurtenis gefilterd: die verschilt per versie van de fabriek, en een
verkeerde hash zou stil nul resultaten geven.

Uit hetzelfde logbericht komen alle contractadressen van de nieuwe chain, en de
belangrijkste daarvan is de **sequencer-inbox**. Daarin staat elke batch die de
chain ooit naar zijn moederketen heeft geschreven. Wie dat adres heeft kan de
chain volledig uitlezen — en er desgewenst een eigen node op draaien — zonder
ooit de RPC van het team nodig te hebben. Een chain kan zijn RPC geheimhouden;
zijn sequencer-inbox niet, want zonder die inbox is hij geen rollup.

Elke fabrieksvondst komt daarna op een tweede volglijst (`data/inboxes.json`).
Elke run wordt `batchCount()` op die inbox opgevraagd; gaat de teller boven de
stand bij uitrol uit, dan **produceert de chain echt** en gaat er een aparte
alert uit. Een rollup-contract uitrollen en er daadwerkelijk een chain op
draaien zijn twee dingen, en het gat ertussen is precies de stille periode
waarin een team alles klaarzet zonder iets te zeggen. Dit leest dat gat af van
de moederketen, zonder ooit de RPC van het team aan te raken.

De stand bij aanvang wordt bewust vastgelegd: sommige inboxen staan bij de
uitrol al op 1, en "groter dan nul" zou dan meteen vals alarm geven.

Het adres dat de uitrol betaalde staat er ook bij. Dat is vaak het enige spoor
naar wie erachter zit: de financieringsgeschiedenis van zo'n adres leidt
geregeld terug naar een herkenbare partij, lang voordat er een naam op de chain
zit.

**`blob-submitters`** — een rollup die écht draait moet zijn data naar Ethereum
schrijven. Blobscan plakt een naam op de adressen die dat doen zodra bekend is
van wie ze zijn. Een adres dat regelmatig blobs post en nog naamloos is, is een
chain die niemand heeft thuisgebracht. De drempel staat op `BLOB_MIN_TXS`
batches binnen het opgehaalde venster, zodat een eenmalige blob geen alert
wordt.

Alle drie leveren de fase `stealth`, en die gaat — net als `launched` — bewust
**buiten `WATCH_KINDS` om**. Dit zijn precies de gebeurtenissen waarvoor de
tool bestaat; die wil je niet kwijtraken aan een instelling van maanden
geleden.

De blokstand per moederketen staat in `data/blocks.json`, naar beneden afgerond
op een grof veelvoud. Zou daar het exacte blok in staan, dan verandert het
bestand bij elke run en commit de workflow zichzelf suf; door grof af te ronden
wordt een stukje opnieuw afgezocht, en die dubbele treffers vangt de seen-set
gratis op.

## Verrijking: socials en "zijn we vroeg"

Een chain-ID-aanvraag geeft je een naam, een ID en een RPC — te weinig om iets mee te doen. Daarom zoekt de tool er zelf omheen:

1. **Website afleiden.** Uit `infoURL` (ethereum-lists), het `website`-veld (Blockscout), of anders het registreerbare domein achter de explorer of de RPC. Infra-domeinen (`blockscout.com`, `llamarpc.com`, `vercel.app`, …) vallen af, want dat is nooit de site van het project zelf.
2. **Socials uit de homepage.** X, Telegram, Discord, GitHub en docs. Bewust regex op de hele broncode en niet alleen op `<a href>`: veel chain-sites zijn SPA's waar de links pas in een JS-bundel staan. Bij meerdere kandidaten wint de handle die het vaakst voorkomt — navigatie staat in header én footer, een toevallige link maar één keer.
3. **Domeinleeftijd via RDAP.** Gratis, geen sleutel, en het sterkste "ben ik vroeg"-signaal dat er is: een chain met een domein van elf dagen oud is nog nergens rondgegaan.
4. **Leeftijd van de GitHub-org** achter de gevonden repo-link.

Alles is best-effort en zit achter een harde tijdslimiet: verrijking mag nooit een detectie tegenhouden of de run van twaalf minuten opeten. Een chain zonder vindbare socials is nog steeds een alert.

## Launch-detectie

Een registratie vertelt je dat een chain gáát komen. Dit vertelt je wanneer hij er ís.

Elke `proposal`- en `upcoming`-detectie komt mét een RPC-URL uit de chain-definitie. Die URL gaat op een wachtlijst (`data/pending.json`) en wordt elke run gepollt met twee goedkope calls: `eth_chainId` en `eth_blockNumber`. Zolang er niets draait, antwoordt hij niet. Zodra hij wél antwoordt is genesis geweest — en dat is meestal uren tot dagen voordat een register de chain als "live" kent. Cosmos-nodes worden herkend aan `/status` (Tendermint), dus de truc werkt ook buiten EVM.

Een RPC die antwoordt is per definitie geen ruis: daar draait iets. De alert bevat de blokhoogte (blok 3 betekent: dit is net gebeurd) en hoeveel dagen er tussen detectie en launch zaten. Meldt de RPC een ánder chain ID dan er is aangevraagd, dan staat dat er expliciet bij in plaats van dat het stilletjes wordt rechtgetrokken.

Launch-alerts gaan buiten `WATCH_KINDS` om en staan bovenaan de berichtenstroom. Komt zo'n alert niet aan, dan blijft de chain op de wachtlijst staan en probeert de volgende run het opnieuw — dezelfde regel als bij gewone detecties. Chains die intussen al door een andere bron als live gemeld zijn, vallen van de lijst zonder tweede bericht. Na `PROBE_TTL_DAYS` dagen zonder levensteken valt een item er stilletjes af.

**Eenmalig na het aanzetten:** `npm run backfill` (of de workflow met `backfill: true`) zet de al bekende openstaande pre-launch chains alsnog op de wachtlijst. Zonder die stap worden alleen nieuwe detecties gevolgd en missen de chains waarvan je de aanvraag al gezien hebt hun launch.

## Promotie: testnet wordt mainnet

Het moment dat een project dat je al kende naar mainnet gaat, is iets anders
dan een wildvreemde chain die opduikt. De dedupe-buckets (`pre` / `test` /
`main`) zorgden er al voor dat zo'n overgang een eigen alert krijgt in plaats
van als duplicaat te worden weggefilterd. Nu wordt hij ook als zodanig
benoemd: het bericht zegt *"kenden we al als testnet — gaat nu mainnet"* en de
prioriteit gaat met 22 punten omhoog.

De vergelijking gebeurt tegen een momentopname van vóór de run. Komt een chain
in dezelfde run zowel als testnet als als mainnet binnen, dan is er geen
geschiedenis om naar terug te wijzen en is het dus geen promotie.

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
  evm.js          JSON-RPC naar de moederketens, met uitwijk per endpoint
  inbox.js        volgt sequencer-inboxen tot de eerste batch
  probe.js        RPC-polling op de wachtlijst: detecteert het launchmoment
  backfill.js     eenmalig: al bekende pre-launch chains op de wachtlijst
data/
  seen/*.json     gezien-keys per bron (git-vriendelijke gesorteerde arrays)
  names.json      cross-bron dedupe-sleutels
  chains.json     laatste 800 detecties met volledige details
  health.json     status per bron + stilteperiode voor foutmeldingen
  pending.json    pre-launch chains waarvan de RPC nog gepollt wordt
  blocks.json     tot welk blok elke moederketen afgezocht is (grof afgerond)
  inboxes.json    sequencer-inboxen die we volgen tot hun eerste batch
  heartbeat.json  wanneer de watcher voor het laatst draaide (op het uur af)
tools/pinger/     Cloudflare Worker die de workflow echt elke 5 minuten start
```

## Een bron toevoegen

Maak `src/sources/jouwbron.js` met een default export `{ id, label, url, fetchAll() }`. `fetchAll` geeft records terug met minimaal `key`, `name`, `nameKey`, `kind`, `source`, `url`. Registreer hem in `src/sources/index.js`. De rest — diffing, dedupe, alerting, dashboard — werkt automatisch.

Optioneel kun je een `enrich(nieuweRecords)` meegeven. Die wordt alleen aangeroepen voor records die nog niet gezien zijn, handig als per item een extra API-call nodig is. Records die `enrich` weglaat komen niet in de alerts maar tellen wél als gezien.

Het dashboard bevat bewust geen "laatste run"-tijdstempel. Zou die er staan, dan verschilt het bestand bij elke run en commit de workflow ~288 keer per dag zonder dat er iets gebeurd is.
