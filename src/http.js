const UA = 'chainwatch/1.0 (github.com/chainwatch)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON met timeout, retries en exponentiele backoff.
 * Gooit pas na alle retries; de caller behandelt een bron-failure als niet-fataal.
 */
export async function getJson(url, { timeout = 30000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`HTTP ${res.status} voor ${url}`);
        err.status = res.status;
        err.retryable = retryable;
        if (!retryable) throw err;
        // respecteer Retry-After indien aanwezig
        const ra = Number(res.headers.get('retry-after'));
        if (ra > 0 && attempt < retries) await sleep(Math.min(ra * 1000, 30000));
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.retryable === false) break;
      if (attempt < retries) await sleep(800 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** GitHub API call, gebruikt GITHUB_TOKEN als die er is (5000 req/u i.p.v. 60). */
export function gh(path, opts = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(opts.headers || {}),
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return getJson(`https://api.github.com${path}`, { ...opts, headers });
}

/**
 * Haalt tekst/HTML op met timeout en een harde byte-limiet.
 * De limiet is er omdat we alleen de <head> en de links nodig hebben; sommige
 * chain-landingspaginas zijn single-page-apps van megabytes en die willen we
 * niet volledig door een runner heen trekken.
 * Gooit niet met retries: dit is best-effort verrijking, geen bron.
 */
export async function getText(url, { timeout = 12000, maxBytes = 400000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} voor ${url}`);
      err.status = res.status;
      throw err;
    }
    // Stream met limiet i.p.v. res.text(): anders lezen we alsnog alles in.
    const reader = res.body?.getReader();
    if (!reader) return { text: (await res.text()).slice(0, maxBytes), finalUrl: res.url || url };
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* al klaar */ }
    return {
      text: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes),
      finalUrl: res.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}
