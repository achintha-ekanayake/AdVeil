/**
 * AdVeil issue-report proxy - lets the popup file a GitHub issue directly,
 * without a personal token. Holds the one GITHUB_TOKEN secret (see
 * README.md), accepts only { title, body, clientId }, rate-limited per
 * client, and rejects reports whose free-text description is empty, too
 * short, or looks like keyboard-mash junk (see looksLikeJunk). None of this
 * confirms a report is *true* - that's still a human triage step, reflected
 * by labeling every accepted report "needs-triage" rather than "bug".
 */

const REPO = 'achintha-ekanayake/adveil';
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3; // issues per window per client
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const BODY_MIN = 20; // below this, there's no room for an actual description

const ALLOWED_ORIGIN_PATTERNS = [/^chrome-extension:\/\//, /^moz-extension:\/\//];

function isAllowedOrigin(origin) {
  return !!origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

// Cheap, deliberately conservative junk filter - catches lazy spam and
// keyboard-mash test submissions, not a determined attacker. Err on the
// side of letting borderline text through rather than rejecting real
// reports.
function looksLikeJunk(text) {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < text.length * 0.25) return true; // mostly symbols/digits
  const freq = {};
  for (const ch of letters.toLowerCase()) freq[ch] = (freq[ch] || 0) + 1;
  const maxFreq = Math.max(...Object.values(freq));
  if (maxFreq / letters.length > 0.5) return true; // one letter dominates, e.g. "aaaaaaaa"
  if (letters.length > 20) {
    const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
    if (vowels / letters.length < 0.08) return true; // near-zero vowels -> keyboard mash
  }
  return false;
}

// The popup assembles `body` as structured markdown (see popup.js) wrapping
// the user's actual free-text description between fixed section headers.
// Junk-checking the whole thing would let real spam hide behind legitimate
// boilerplate words like "Browser" and "Site URL", so pull out just the
// user-authored "What happened" text when the expected format is present,
// and fall back to the whole body for any other client/shape.
function extractUserText(body) {
  const match = body.match(/\*\*What happened\*\*:\n([\s\S]*?)\n\n\*\*What you expected\*\*:/);
  return match ? match[1].trim() : body;
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
    const userText = extractUserText(body);
    if (userText.length < BODY_MIN || looksLikeJunk(userText)) {
      return new Response('Report looks incomplete - please add a real description of what happened.', {
        status: 400,
        headers: corsHeaders(origin)
      });
    }

    const rateKey = `rl:${clientId || request.headers.get('CF-Connecting-IP') || 'anon'}`;
    const allowed = await checkRateLimit(env.ISSUE_RATE_LIMIT_KV, rateKey);
    if (!allowed) {
      return new Response('Rate limit exceeded - try again later.', { status: 429, headers: corsHeaders(origin) });
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
        // "needs-triage", not "bug" - this hasn't been confirmed as a real
        // defect yet, just accepted past automated spam/format checks.
        labels: ['needs-triage', 'from-extension']
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
