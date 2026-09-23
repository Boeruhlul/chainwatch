# dex-pools: nieuwe pools op gekozen chains

> **Staat uit sinds 2026-09-23.** De eerste runs lieten 55-76 nieuwe pools per
> 5 minuten zien op Robinhood Chain en Arc samen (Elysium: nul). Dat is geen
> alertstroom maar een brandslang. Aanzetten met `DEX_POOLS_ENABLED=true`; zinvol
> pas met een filter erop (bijvoorbeeld minimale liquiditeit).

Geen chain-detectie maar handel: deze bron meldt elke nieuwe liquiditeitspool
op Robinhood Chain (4663), Arc (5042) en Elysium (1339). GIWA staat klaar maar
uit, tot de mainnet publiek is.

## Hoe het zoekt

Op de handtekening van het event, zonder adresfilter: elke Uniswap v2/v3-fork,
Uniswap v4 (`Initialize` op de PoolManager), Solidly- en Aerodrome-forks,
Slipstream en Algebra. Een DEX die gisteren is uitgerold en waarvan niemand het
fabrieksadres kent, wordt dus ook gevonden. De hashes worden in
`test/dex-pools.js` nagerekend met een eigen keccak.

Voor elke nieuwe pool worden de tokensymbolen opgehaald (`symbol()`), zodat het
bericht "PEPE / WETH" zegt in plaats van twee kale adressen. Symbolen komen van
wie het token uitrolde en worden altijd ge-escaped.

Een v4-pool met een eigen hook-contract wordt apart vermeld: zo'n hook kan
belasting heffen of verkopen blokkeren.

## Gedrag

- Pools gaan altijd door, buiten `WATCH_KINDS` om, naar hetzelfde kanaal.
- Ze tellen niet mee in `names.json`, de verrijking of de dashboard-historie.
- De blokstand staat in een eigen `data/pool-blocks.json` (niet `blocks.json`:
  bronnen draaien parallel en zouden elkaars stand overschrijven), afgerond op
  ongeveer een uur per chain tegen commit-ruis.
- Loopt de scanner meer dan een etmaal achter, dan springt hij vooruit: een
  pool van gisteren is geen nieuws.
- Meer dan 25 nieuwe pools in één run worden één samenvattingsbericht.
- De eerste run legt stil een baseline vast.

## Instellingen

| Variabele | Standaard | Wat |
|---|---|---|
| `DEX_POOL_CHAINS` | `robinhood,arc,elysium` | Welke chains; `giwa` kan erbij |
| `DEX_POOL_BUDGET_SECONDS` | `40` | Tijdslimiet voor het afzoeken |
| `DEX_POOL_SYMBOL_SECONDS` | `20` | Tijdslimiet voor tokensymbolen |
| `EVM_RPC_ROBINHOOD`, `_ARC`, `_ELYSIUM`, `_GIWA` | publieke endpoints | Eigen RPC's, komma-gescheiden |

Deze staan nog niet in `watch.yml`, dus in Actions gelden de standaarden.
Afstellen via repo-variabelen vraagt een regel per variabele in dat bestand.

Uitzetten: `DISABLED_SOURCES=dex-pools`.
