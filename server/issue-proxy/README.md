# Issue report proxy

A Cloudflare Worker that files a GitHub issue on behalf of the extension's popup, without the user visiting GitHub or holding a token. Holds the one required credential and enforces a per-client rate limit.

## Setup

Requires a [Cloudflare account](https://dash.cloudflare.com) and the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) CLI.

1. **Create a GitHub token** scoped to this repo only:
   - GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Repository access: `achintha-ekanayake/adveil` only.
   - Permissions: Issues (Read and write). Nothing else.

2. **Create the rate-limit KV namespace**:
   ```sh
   wrangler kv namespace create ISSUE_RATE_LIMIT_KV
   ```
   Copy the returned `id` into `wrangler.toml`.

3. **Set the token as a secret**:
   ```sh
   wrangler secret put GITHUB_TOKEN
   ```

4. **Deploy**:
   ```sh
   wrangler deploy
   ```
   Note the resulting `*.workers.dev` URL.

5. **Point the extension at it**: set `ISSUE_PROXY_URL` in `popup/popup.js`.

## Continuous deploy

`.github/workflows/deploy-issue-proxy.yml` redeploys on every push to `main` that touches `server/issue-proxy/**`. It does not manage the KV binding or the `GITHUB_TOKEN` secret; those are set once via the steps above and persist across deploys.

Requires two repository secrets (repo → Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard sidebar.

Can also be triggered manually via `workflow_dispatch`.

## Design notes

- Accepts only `{ title, body, clientId }`; no other GitHub API parameter is exposed to callers.
- Creates issues on one hardcoded repo only.
- Rejects requests whose `Origin` is not `chrome-extension://` or `moz-extension://`.
- Rate-limits by client-supplied ID (falls back to connecting IP), 3 issues/hour per client. Deters casual abuse only; not a defense against a determined attacker spoofing origin and ID.
- Rejects reports where the "What happened" text is missing, under 20 characters, or matches a keyboard-mash/repeated-character/symbol-spam heuristic (`looksLikeJunk` in `worker.js`). This filters obvious junk; it does not verify a report is accurate.
- Accepted reports are labeled `needs-triage` and `from-extension`, not `bug` — confirming a report is a real defect remains a manual review step.
