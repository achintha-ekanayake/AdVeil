# Store submission reference

Copy-paste source for the Chrome Web Store and Firefox AMO listings. Keep this in sync with `manifest.json` and `docs/privacy.html` — if either changes, update this file too.

**Privacy policy URL** (confirmed live): `https://achintha-ekanayake.github.io/AdVeil/privacy.html`

## Single purpose description

> Blocks overlay ads, popup/clickunder redirects, and trackers using on-page detection and a curated filter list.

## Short description (~132 chars, matches manifest.json)

> Open-source extension that blocks overlay ads, popunder redirects, and trackers using on-page heuristics and a curated filter list.

## Detailed description (store listing body)

> AdVeil detects and blocks intrusive overlay ads, popup/"clickunder" redirects, and tracker requests, using a combination of on-page heuristic detection and a curated filter list — not a full copy of any third-party blocklist.
>
> **What it does:**
> - Hides full-screen interstitials, sticky popups, and anti-adblock nags using a weighted heuristic engine that scores page elements as they appear, rather than a static list of known ad sites.
> - Blocks popup/"clickunder" redirects — scripts that hijack a click to open a scam or ad tab.
> - Blocks requests to a curated list of known ad and tracker domains.
> - Hides common ad containers via CSS.
>
> **Privacy:** All detection happens locally in your browser. AdVeil does not collect, transmit, or sell browsing data. Full privacy policy: https://achintha-ekanayake.github.io/AdVeil/privacy.html
>
> **Open source:** Full source code, including the backend for the optional bug-report feature, is available at github.com/achintha-ekanayake/AdVeil.

## Permission justifications (Chrome Web Store "Privacy practices" tab)

| Permission | Justification |
|---|---|
| `declarativeNetRequest` | Blocks requests to a curated list of known ad/tracker domains using Chrome's built-in declarative rule engine. The extension never reads or intercepts request content. |
| `storage` | Stores the user's on/off toggle, per-site pause list, and aggregate block counts locally in the browser. Nothing is stored remotely. |
| `tabs` | Identifies the active tab so the popup can show per-site status and blocked-ad counts, and resets counts when a tab navigates. Only reads the tab's URL, not page content. |
| `host_permissions: <all_urls>` | AdVeil hides overlay ads before they render, which requires running as each page loads — not only after the user clicks the extension icon, which the narrower `activeTab` permission would require. This is the extension's core function, not incidental to it. |

## Data usage disclosure answers

Chrome's Privacy Practices form asks you to certify specific data-handling claims. Answer based on this:

- **Does the extension collect personal or sensitive user data?** No, for its core ad-blocking function. The optional "Report an issue" popup form transmits data (free-text description, current page URL, browser name, extension version, a random non-identifying install ID) **only when the user explicitly fills in and submits it** — never automatically.
- **Is data sold to third parties?** No.
- **Is data used for purposes unrelated to the extension's core functionality?** No.
- **Is data used to determine creditworthiness or for lending?** No.

## Firefox AMO — data collection permissions

The submission form will ask you to confirm the categories declared in `manifest.json`'s `browser_specific_settings.gecko.data_collection_permissions`: **required: none**; **optional: technical/interaction data, browsing activity** (the current page URL, browser name, and extension version — sent only if the user explicitly submits the popup's report form). Answer AMO's data collection questionnaire consistently with this.

## Firefox AMO — notes for reviewers

Paste into the "Notes to Reviewer" field on submission:

> This extension requests `<all_urls>` because its core function (detecting overlay ads before they render) requires running on every page load. `content-scripts/popunder-guard.js` uses `"world": "MAIN"` and `all_frames: true` with `match_origin_as_fallback: true` to override `window.open` in every frame including dynamically-created `about:blank` ad frames, which is necessary to block popup/clickunder redirects that otherwise bypass frame-scoped protections — see `plan.md` "Finding 4" in the repo for the full rationale. Privacy policy: https://achintha-ekanayake.github.io/AdVeil/privacy.html. Full source: github.com/achintha-ekanayake/AdVeil.

## Release packages

Built via `npm run build` (refresh DNR rules) + a staged copy of only the runtime files (`manifest.json`, `background/`, `content-scripts/`, `popup/`, `icons/`, `rules/generated/dnr-rules.json`, `LICENSE` — not `plan.md`, `docs/`, `server/`, `test/`, or the DNR build sources). Chrome package zipped directly; Firefox package built with `npx web-ext build` (also run `npx web-ext lint` before submitting — 0 errors required, warnings about the ignored `background.service_worker` key on Firefox are expected and fine, that's the Chrome-only half of the intentional dual-key fallback).

## Enabling the privacy policy URL (GitHub Pages)

1. GitHub repo → **Settings** → **Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: `/docs`.
3. Save. The page will be live at `https://achintha-ekanayake.github.io/AdVeil/privacy.html` within a few minutes.
4. Use that URL in both store submission forms.

`docs/.nojekyll` is already checked in - without it, GitHub Pages tries to run the plain HTML through Jekyll's default theme build and fails (`Conversion error... assets/css/style.scss`). The marker file skips that and serves the files as static HTML directly.
