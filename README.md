# AdVeil

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest](https://img.shields.io/badge/Manifest-V3-informational)](manifest.json)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Firefox-orange)](#installation)

AdVeil is an open-source, cross-browser extension that blocks overlay ads, popunder redirects, and trackers. It combines on-page heuristic detection with a curated network and cosmetic filter list, targeting both Chrome and Firefox from a single Manifest V3 codebase.

## Features

- **Overlay ad detection** - identifies and hides full-screen interstitials, sticky popups, anti-adblock nags, and cookie-wall-style overlays using a weighted heuristic engine, not a static selector list.
- **Popunder / clickunder protection** - blocks scripts that hijack clicks to open ad, gambling, or scam redirects in a new tab, including instances triggered from embedded third-party iframes.
- **Network-level blocking** - blocks requests to a curated list of known ad and tracker domains via `declarativeNetRequest`.
- **Cosmetic filtering** - hides common ad containers (`.adsbygoogle`, banner slots, native ad widgets) via injected CSS.
- **Per-site control** - global on/off toggle, per-site pause, and a one-click restore for pages affected by a false positive.

## Installation

- **Chrome / Chromium / Edge**: [install from the Chrome Web Store](https://chromewebstore.google.com/detail/adveil/klfjblcfnhfplgmacacfanaigeiimbje).
- **Firefox**: [install from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/adveil-adblocker/).

To run an unpacked build from source instead:

**Chrome / Chromium / Edge**
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the project root.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on…** and choose `manifest.json`.
3. Temporary add-ons are removed on restart. For a persistent development session, use Mozilla's [`web-ext`](https://github.com/mozilla/web-ext) CLI.

## Usage

Click the toolbar icon to open the popup:

- **Protection** - global on/off toggle.
- **Paused on \<site\>** - disables filtering for the current site only.
- **Blocked count** - number of ads removed on the current page.
- **Restore hidden elements** - reverses hides on the current page, for sites affected by a false positive.
- **Report an issue** - files a GitHub issue directly from the popup (site, browser, and extension version attached automatically), with no need to visit GitHub. This talks to a small self-hosted backend ([`server/issue-proxy/`](server/issue-proxy/README.md)) that holds the GitHub token; forks won't have this working until they deploy their own instance.

## Project structure

```
├── manifest.json
├── background/service-worker.js     # badge counters, storage migration
├── content-scripts/
│   ├── overlay-engine.js            # heuristic overlay detection
│   ├── cosmetic-filter.js           # CSS-based ad hiding
│   └── popunder-guard.js            # blocks cross-origin window.open popups
├── popup/                           # toolbar UI, including the report-issue form
├── rules/
│   ├── domains-source.txt           # curated network blocklist (source)
│   ├── build-dnr-rules.js           # compiles the blocklist to DNR rules
│   └── generated/dnr-rules.json     # build output, checked in
├── server/issue-proxy/              # backend for the in-popup report form
└── test/overlay-test.html           # local fixture page for manual testing
```

## Development

The network blocklist is checked in, so no build step is required to load the extension. After editing `rules/domains-source.txt`, regenerate it:

```sh
npm run build
```

The in-popup "Report an issue" form requires a small backend to submit on the user's behalf without a personal token. See [`server/issue-proxy/README.md`](server/issue-proxy/README.md) for deployment; until deployed, the form shows a clear error instead of failing silently.

For design rationale, architecture decisions, and a record of issues found during testing, see [`plan.md`](plan.md).

## Known limitations

- The network and cosmetic filter lists are curated, not a full EasyList/EasyPrivacy import - coverage is intentionally narrower than established ad blockers.
- Ads served through ad-blocker-circumvention networks that rotate delivery domains per request can evade static domain blocking.
- The overlay engine and cosmetic filter run in the top frame only; the popunder guard runs in all frames, including dynamically created ones.
- Detection uses a fixed scoring threshold rather than a user-configurable sensitivity setting.

Full details are documented in [`plan.md`](plan.md).

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, testing expectations, and pull request guidelines.

## Security

To report a vulnerability, see [`SECURITY.md`](SECURITY.md). Please do not open a public issue for security reports.

## Privacy

AdVeil requests broad permissions (`<all_urls>`) because ad detection has to run on every page load. See the [privacy policy](docs/privacy.html) for exactly what that access is used for and what, if anything, ever leaves your device.

## License

Released under the [MIT License](LICENSE).

## Disclaimer

AdVeil is provided as-is, with no warranty of any kind. It is not affiliated with any browser vendor, ad network, or the websites it may modify. Users are responsible for compliance with the terms of service of any site they visit.
