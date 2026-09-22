/**
 * chainwatch-pinger — Cloudflare Worker.
 *
 * Waarom dit bestaat: GitHub voert `schedule`-triggers niet betrouwbaar uit.
 * Op deze repo werd een cron van elke 5 minuten in de praktijk elke 3 tot 5
 * uur uitgevoerd. `workflow_dispatch` wordt NIET afgeknepen, dus een externe
 * trigger die elke paar minuten de API aanroept geeft je wel de cadans die je
 * gevraagd hebt.
 *
 * De workflow heeft een `concurrency`-groep, dus een trigger die binnenkomt
 * terwijl er al een run bezig is levert geen dubbele run op — hij wacht.
 *
 * Uitrollen:
 *   wrangler deploy
 *   wrangler secret put GITHUB_TOKEN     (fine-grained PAT, alleen deze repo,
 *                                         permissie Actions: read and write)
 *
 * De cadans staat in wrangler.toml, niet hier.
 */

const UA = 'chainwatch-pinger';

async function dispatch(env) {
  const repo = env.REPO || 'Boeruhlul/chainwatch';
  const workflow = env.WORKFLOW || 'watch.yml';
  const ref = env.BRANCH || 'main';

  if (!env.GITHUB_TOKEN) {
    return { ok: false, status: 0, detail: 'GITHUB_TOKEN ontbreekt (wrangler secret put GITHUB_TOKEN)' };
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': UA,
      },
      body: JSON.stringify({ ref }),
    }
  );

  // 204 is succes en heeft geen body. Alles daarbuiten wil je kunnen lezen.
  const detail = res.status === 204 ? 'gestart' : (await res.text()).slice(0, 400);
  return { ok: res.ok, status: res.status, detail };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatch(env).then((r) => {
        // Zichtbaar in `wrangler tail`. Een 401 betekent een verlopen token,
        // een 404 meestal een token zonder Actions-permissie op deze repo.
        console.log(`[chainwatch-pinger] ${r.status} ${r.detail}`);
      })
    );
  },

  // Handmatig aanroepen om de opstelling te testen: open de worker-URL.
  async fetch(request, env) {
    const r = await dispatch(env);
    return new Response(JSON.stringify(r, null, 2), {
      status: r.ok ? 200 : 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};
