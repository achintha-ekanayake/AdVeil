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
   wrangler kv namespace create ISSUE_RATE_LIMIT_KV
   ```
   Copy the returned `id` into `wrangler.toml`.

3. **Set the token as a secret** (never committed to the repo):
   ```sh
   wrangler secret put GITHUB_TOKEN
   ```

4. **Deploy once by hand**, to confirm setup and get the URL:
   ```sh
   wrangler deploy
   ```
   Note the resulting `*.workers.dev` URL.

5. **Point the extension at it**: set `ISSUE_PROXY_URL` in `popup/popup.js` to that URL.

## Continuous deploy

After the one-time setup above, `.github/workflows/deploy-issue-proxy.yml` redeploys automatically on every push to `main` that touches `server/issue-proxy/**` (docs/UI/rule changes elsewhere don't trigger it). It never touches the KV binding or the `GITHUB_TOKEN` secret - those are set once by hand via the steps above and persist across deploys.

For the workflow to authenticate, add two **repository secrets** (GitHub repo → Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` - create at Cloudflare dashboard → My Profile → API Tokens → **Create Token** → use the "Edit Cloudflare Workers" template, scoped to this account.
- `CLOUDFLARE_ACCOUNT_ID` - shown on the right sidebar of any page in the Cloudflare dashboard for this account. Not a secret exactly, but stored the same way for convenience.

Without these two secrets set, the workflow run fails at the deploy step; nothing else in the repo is affected. You can also trigger it manually from the Actions tab (`workflow_dispatch`) if you need a redeploy with no code change - e.g. after rotating `GITHUB_TOKEN`.

## Design notes

- Only accepts `{ title, body, clientId }` - no other GitHub API parameter is exposed to callers.
- Only creates issues on one hardcoded repo.
- Rejects requests whose `Origin` isn't a `chrome-extension://` or `moz-extension://` scheme.
- Rate-limits by a client-supplied anonymous ID (falls back to the connecting IP), capped at 3 issues per hour per client. This deters casual abuse; it is not a defense against a determined attacker spoofing origins and IDs. Pair with Cloudflare's dashboard-level rate limiting for stronger protection if abuse becomes a problem.
- Rejects reports whose "What happened" text is missing, under 20 characters, or looks like keyboard-mash/repeated-character/symbol junk (`looksLikeJunk` in `worker.js`). This is a cheap, deliberately conservative filter for lazy spam - not a spam classifier, and not a check that a report is *true*.
- Every accepted report is labeled `needs-triage` (plus `from-extension`), not `bug` - passing these checks only means it's well-formed, not that it's a confirmed defect. Whether it's a real bug is still a human call made when the issue is reviewed.
