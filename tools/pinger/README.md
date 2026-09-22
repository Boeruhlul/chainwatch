# chainwatch-pinger

GitHub voert `schedule`-triggers niet betrouwbaar uit. Gemeten op deze repo:
een cron van `*/5` draaide in de praktijk elke 3 tot 5 uur — 40 runs in een
week waar er ~2.000 hadden moeten staan. Dat is bekend gedrag, GitHub knijpt
schedules af op repo's met weinig activiteit en slaat ze soms helemaal over.

`workflow_dispatch` heeft die beperking niet. Deze worker roept dat elke 5
minuten aan.

## Opzetten

**1. Token maken.** GitHub → Settings → Developer settings → Personal access
tokens → Fine-grained tokens → Generate new token.

- Repository access: **Only select repositories** → `chainwatch`
- Permissions → Repository permissions → **Actions: Read and write**
- Verder niets aanvinken. Zet een verloopdatum die je bijhoudt.

**2. Worker uitrollen.**

```sh
cd tools/pinger
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN   # plak het token
```

**3. Testen.** Open de worker-URL in je browser. Je krijgt JSON terug; bij
`{"ok": true, "status": 204, "detail": "gestart"}` staat er een run in Actions.

- **401** — token verlopen of verkeerd geplakt.
- **404** — token heeft geen Actions-permissie op deze repo, of de repo-naam
  in `wrangler.toml` klopt niet. GitHub geeft bewust 404 in plaats van 403 bij
  te weinig rechten.
- **422** — de branch in `BRANCH` bestaat niet, of `watch.yml` heeft geen
  `workflow_dispatch`-trigger.

## Zonder Cloudflare

Elke cron-dienst die een POST kan doen werkt, bijvoorbeeld cron-job.org:

- URL: `https://api.github.com/repos/Boeruhlul/chainwatch/actions/workflows/watch.yml/dispatches`
- Methode: POST, elke 5 minuten
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`
- Body: `{"ref":"main"}`

## Dubbele runs

Die komen er niet. `watch.yml` heeft een `concurrency`-groep met
`cancel-in-progress: false`: een trigger die binnenkomt terwijl er al een run
loopt, wacht netjes zijn beurt af.

De `schedule`-trigger in `watch.yml` blijft staan als vangnet voor als de
pinger zelf uitvalt.
