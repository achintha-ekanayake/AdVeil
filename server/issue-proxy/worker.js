/**
 * AdVeil issue-report proxy.
 *
 * Lets the extension's popup file a GitHub issue directly, without the user
 * visiting GitHub or holding a personal access token. This Worker holds the
 * one credential (GITHUB_TOKEN, set as a secret — see README.md in this
 * directory) and is the only thing allowed to write to the repo's issues.
 *
 * Deliberately narrow: accepts only { title, body, clientId }, writes only
 * to one hardcoded repo, and applies a KV-backed rate limit per client. It
 * does not accept arbitrary GitHub API parameters from the caller.
 */

const REPO = 'achintha-ekanayake/adveil';
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3; // issues per window per client
const TITLE_MAX = 200;
const BODY_MAX = 4000;

const ALLOWED_ORIGIN_PATTERNS = [/^chrome-extension:\/\//, /^moz-extension:\/\//];

function isAllowedOrigin(origin) {
  return !!origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

async function checkRateLimit(kv, key) {
  if (!kv) return true; // fail open if KV isn't bound (e.g. local dev)
  const now = Date.now();
  const raw = await kv.get(key);
  let hits = raw ? JSON.parse(raw) : [];
  hits = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  await kv.put(key, JSON.stringify(hits), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) });
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin)) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders(origin) });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders(origin) });
    }

    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    const clientId = typeof payload.clientId === 'string' ? payload.clientId.slice(0, 64) : '';

    if (!title || title.length > TITLE_MAX) {
      return new Response('Invalid title', { status: 400, headers: corsHeaders(origin) });
    }
    if (!body || body.length > BODY_MAX) {
      return new Response('Invalid body', { status: 400, headers: corsHeaders(origin) });
    }

    const rateKey = `rl:${clientId || request.headers.get('CF-Connecting-IP') || 'anon'}`;
    const allowed = await checkRateLimit(env.ISSUE_RATE_LIMIT_KV, rateKey);
    if (!allowed) {
      return new Response('Rate limit exceeded — try again later.', { status: 429, headers: corsHeaders(origin) });
    }

    const ghResponse = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'adveil-issue-proxy',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title,
        body: `${body}\n\n---\n_Filed automatically via the AdVeil extension's report form._`,
        labels: ['bug', 'from-extension']
      })
    });

    if (!ghResponse.ok) {
      return new Response(`GitHub API error (${ghResponse.status})`, { status: 502, headers: corsHeaders(origin) });
    }

    const issue = await ghResponse.json();
    return new Response(JSON.stringify({ url: issue.html_url }), {
      status: 201,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
    });
  }
};
