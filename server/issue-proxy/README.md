# Issue report proxy

A Cloudflare Worker that lets the extension file a GitHub issue directly from its popup, without the user visiting GitHub or holding a token. The Worker holds the one credential needed and enforces a per-client rate limit.

## Deploy

Requires a [Cloudflare account](https://dash.cloudflare.com) and the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) CLI.

1. **Create a GitHub token** scoped narrowly to this repo:
   - GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Repository access: only `achintha-ekanayake/adveil`.
   - Permissions: **Issues: Read and write**. Nothing else.

2. **Create the rate-limit KV namespace**:
   ```sh
   wrangler kv:namespace create ISSUE_RATE_LIMIT_KV
   ```
   Copy the returned `id` into `wrangler.toml`.

3. **Set the token as a secret** (never committed to the repo):
   ```sh
   wrangler secret put GITHUB_TOKEN
   ```

4. **Deploy**:
   ```sh
   wrangler deploy
   ```
   Note the resulting `*.workers.dev` URL.

5. **Point the extension at it**: set `ISSUE_PROXY_URL` in `popup/popup.js` to that URL.

## Design notes

- Only accepts `{ title, body, clientId }` — no other GitHub API parameter is exposed to callers.
- Only creates issues on one hardcoded repo.
- Rejects requests whose `Origin` isn't a `chrome-extension://` or `moz-extension://` scheme.
- Rate-limits by a client-supplied anonymous ID (falls back to the connecting IP), capped at 3 issues per hour per client. This deters casual abuse; it is not a defense against a determined attacker spoofing origins and IDs. Pair with Cloudflare's dashboard-level rate limiting for stronger protection if abuse becomes a problem.
