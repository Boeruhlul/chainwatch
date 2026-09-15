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
