# Discovery-laag

Bovenop de bronnen die losse detecties leveren zit sinds 28 oktober 2026 een laag die die detecties per project bijhoudt, verbanden legt en ze beoordeelt.

## Dossiers (`src/dossiers.js`, `data/dossiers.json`)

Eén dossier per project. Detecties worden gekoppeld via identiteitssleutels:

| Sleutel | Bron |
|---|---|
| `n:<naam>` | naam zonder testnet/mainnet (generieke namen tellen niet) |
| `id:<chainId>` | chain ID |
| `d:<domein>` | website-domein (infra-domeinen zoals github.com of vercel.app tellen niet) |
| `gh:<org>` | GitHub-organisatie |
| `a:<adres>` | sequencer-inbox of batcher-adres van een stealth-vondst |

Deelt een nieuwe detectie sleutels met twee bestaande dossiers, dan worden die samengevoegd. Dat levert een melding **🔗 CODENAAM / PROJECT GEKOPPELD** op, met de sleutel waarop het gebeurde. Een koppeling op alleen een chain ID kan een botsing zijn: lees altijd de `via`-regel.

### Fase

`lead` → `aangekondigd` → `devnet` → `testnet` → `draait` → `mainnet`. De fase volgt uit het sterkste bewijs. `stageHistory` legt per dag vast wanneer een dossier een fase opschoof.

### Confidence A–D

Er zijn geen percentages; elk oordeel krijgt zijn redenen mee.

| | Wanneer |
|---|---|
| **A** bevestigd nieuw netwerk | er draait aantoonbaar iets: een RPC antwoordt, een register heeft het netwerk opgenomen, of er staat een DEX of launchpad op |
| **B** sterke aanwijzing | meerdere onafhankelijke bronfamilies, of on-chain activiteit zonder naam |
| **C** interessante hypothese | één technisch signaal (een chain-ID-aanvraag, een L2BEAT-vermelding, een repo met chainconfig, een certificaat) |
| **D** zwakke lead | alleen nieuws of een losse onderzoekshypothese |

Bronnen tellen per familie: een PR en de commit van diezelfde PR zijn samen één signaal. De families zijn register, code, markt, onchain, infra, github, nieuws en onderzoek.

Een onderzoeksoordeel kan een dossier alleen naar boven bijstellen, nooit naar beneden, en wordt apart vermeld.

### Wat wanneer gemeld wordt

- **Gewone alerts** (zoals voorheen) krijgen een regel `📁 Confidence X · eerst gezien …` met eerder bewijs eronder.
- **🧩 VERBAND GELEGD**: een dossier stijgt naar A of B door bewijs dat zelf geen alert gaf, zoals een funding-bericht en daarna een repo van dezelfde org.
- **🔗 GEKOPPELD**: twee dossiers blijken één project.
- **🏁 EERSTE DEX / LAUNCHPAD**: zie hieronder.
- Al het andere (C/D-leads, kleine wijzigingen) gaat naar het **dagoverzicht**.

Komt een dossiermelding niet aan, dan blijft hij in `outbox` staan en wordt hij de volgende run opnieuw verstuurd. Oude leads worden nooit verwijderd.

### Commit-ruis

Datums in de dossiers zijn dagen, geen tijdstippen, en er staan geen tellers in. Komt er geen bewijs bij, dan blijft het bestand byte-identiek (test D7).

## Ecosysteem-scan (`src/ecosystem.js`)

Voor elk dossier dat intensief gevolgd wordt en een RPC heeft. Intensief betekent: pre-launch met activiteit in de laatste 180 dagen, of de eerste 14 dagen na mainnet. Elke run leest de scan de logboeken van maximaal de laatste 20.000 blokken.

- **DEX**: `PairCreated`/`PoolCreated`/`Initialize` van Uniswap v2/v3/v4, Solidly, Slipstream en Algebra. Het contract dat die gebeurtenis uitzendt is de fabriek.
- **Launchpad-kandidaat**: een *contract* dat de beginvoorraad van 3 of meer verse tokens ontvangt (Transfer vanaf 0x0). Zo werken bonding-curve-platforms als pump.fun en noxa.fun. EOA's, pools, NFT's en `0xdead` tellen niet mee.

Alleen de eerste DEX en de eerste launchpad van een chain worden een directe melding; latere vondsten komen in het dossier. De scan is stateloos: welke chains aan de beurt zijn volgt uit de klok (12 per run), en er wordt geen blokstand bewaard.

Instellingen: `ECO_ENABLED`, `ECO_LIMIT` (12), `ECO_BUDGET_SECONDS` (40).

**Wat de scan niet vindt:** de *website* van een launchpad. Hij vindt alleen het contractadres. Via de explorer-link vind je meestal de deployer en daarmee de site.

## Nieuwe bronnen

| Bron | Wat | Frequentie | Alert? |
|---|---|---|---|
| `github-discovery` | Repo's van de laatste 3 dagen met chainwoorden. Telt alleen mee als de repo een chainconfig bevat (genesis, rollup.json, OP deploy-config, Orbit-nodeconfig, Cosmos chain.json, ZK Stack). Daarnaast onbekende netwerknamen die in repo-omschrijvingen genoemd worden ("… on Tau Testnet"). | elk uur (:00–:10) | nee, via dossier/dagoverzicht |
| `funding-rss` | The Block, Blockworks, CoinDesk, Decrypt en Cointelegraph, gefilterd op financiering plus chainwoorden. Haalt de projectnaam uit de titel. | elk uur (:20–:30) | nee, via dossier/dagoverzicht |
| `research` | `data/research/*.json` uit de wekelijkse deep research (zie RESEARCH.md) | elke run | één overzichtsbericht per bestand |

Uitzetten kan per bron met `GH_DISCOVERY=false`, `FUNDING_RSS=false` of via `DISABLED_SOURCES`.

## Dagoverzicht (`src/briefing.js`)

Eén keer per dag na `DIGEST_HOUR` (default 8, Amsterdamse tijd). Het bevat:

- nieuwe A/B-netwerken
- netwerken die een fase opschoven
- nieuwe DEX'en en launchpads
- onbevestigde C/D-signalen
- het aantal intensief gevolgde dossiers en bronnen in storing

Als er niets gebeurd is staat dat er letterlijk. Op maandag komt er een weekblok bij met de stand per confidence en de stille C/D-leads die opnieuw bekeken moeten worden.

## Blinde vlekken

- Chains die nergens publiek iets achterlaten: een private node zonder eigen certificaat, geen repo en geen register.
- Een repo die eerst leeg aangemaakt wordt en pas later een genesis krijgt. Hij wordt maar één keer bekeken, kort na aanmaak.
- Non-EVM ecosystemen voor de DEX/launchpad-scan. Die werkt alleen op EVM.
- Private GitHub-repo's, besloten Discords en X zonder betaalde API.
- Funding-berichten waarvan de titel de naam niet vooraan zet.
