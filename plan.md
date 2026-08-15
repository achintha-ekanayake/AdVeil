# AdVeil - Design Document

Cross-browser overlay + ad blocker extension (Manifest V3).

## Contents

- [Context](#context)
- [File Structure](#file-structure)
- [manifest.json](#manifestjson)
- [Network blocking (declarativeNetRequest)](#network-blocking-declarativenetrequest)
- [Cosmetic filtering](#cosmetic-filtering-cosmetic-filterjs)
- [Overlay heuristic engine](#overlay-heuristic-engine-overlay-enginejs---core-feature)
- [Messaging & badge](#messaging--badge)
- [Storage schema](#storage-schema-chromestoragelocal)
- [Popup UI](#popup-ui)
- [Verification](#verification)
- [Explicit MVP scope limits](#explicit-mvp-scope-limits)
- [Small implementation-time checks](#small-implementation-time-checks-not-architecture-changes)
- [Findings Log](#findings-log)
  - [Finding 1: Cross-script namespace collision silently disabled the overlay engine](#finding-1-cross-script-namespace-collision-silently-disabled-the-overlay-engine)
  - [Finding 2: Coverage-ratio blind spot missed standard-size ad units](#finding-2-coverage-ratio-blind-spot-missed-standard-size-ad-units)
  - [Finding 3: False positive from the "paywall" keyword](#finding-3-false-positive-from-the-paywall-keyword)
  - [Finding 4: Clickunder popunder ads - a new attack class, new file added](#finding-4-clickunder-popunder-ads---a-new-attack-class-new-file-added)
  - [Finding 5: canyoublockit.com/extreme-test/ - ad-blocker-circumvention network and a keyword false positive](#finding-5-canyoublockitcomextreme-test---ad-blocker-circumvention-network-and-a-keyword-false-positive)
  - [Finding 6: Breaking GitHub's own mobile navigation menu](#finding-6-breaking-githubs-own-mobile-navigation-menu)
  - [Finding 7: Confirmation gate loophole - "overlay" as a keyword](#finding-7-confirmation-gate-loophole---overlay-as-a-keyword)
  - [Finding 8: The entire page - `<body>` itself - got hidden](#finding-8-the-entire-page---body-itself---got-hidden)
  - [Finding 9: A WordPress theme's main content wrapper got hidden, collapsing the page to zero height](#finding-9-a-wordpress-themes-main-content-wrapper-got-hidden-collapsing-the-page-to-zero-height)
  - [Finding 10: Cloudflare's own dashboard drawer got hidden, blocking a deployment step](#finding-10-cloudflares-own-dashboard-drawer-got-hidden-blocking-a-deployment-step)
  - [Finding 11: MUI docs' "Settings" drawer got hidden via the scroll-lock signal](#finding-11-mui-docs-settings-drawer-got-hidden-via-the-scroll-lock-signal)
  - [Finding 12: Cloudflare's Kumo-design-system Select dropdown got hidden](#finding-12-cloudflares-kumo-design-system-select-dropdown-got-hidden)
  - [Finding 13: Base UI's inert popup/drawer backdrop got hidden](#finding-13-base-uis-inert-popupdrawer-backdrop-got-hidden)
  - [Finding 14: a real dialog without aria-modal slipped past the Finding 11 exclusion](#finding-14-a-real-dialog-without-aria-modal-slipped-past-the-finding-11-exclusion)

## Context

The project directory (`Add-blocker`) started empty - this was a greenfield build, not git-initialized at the start. The user wanted a browser extension for both Firefox and Chrome that blocks **overlaying ads** (full-screen interstitials, sticky popups, anti-adblock nags, cookie-wall-style ad overlays that cover page content). Based on clarifying answers, the scope was expanded to also include **general ad blocking** (network-level domain blocking + generic cosmetic hiding), using a **hybrid detection approach** (heuristic DOM analysis as the primary/original mechanism + a curated filter-list layer for precision), built as a **single Manifest V3 codebase** loadable unpacked in both Chrome and Firefox, with a **toolbar popup UI** (on/off toggle, per-site pause, blocked-count display).

The overlay-heuristic engine is the core original value; the network/cosmetic ad blocking is an intentionally-scoped-down "mini ad blocker" layer (curated few-hundred-domain list, not a full EasyList import) so the MVP stays buildable.

## File Structure

```
Add-blocker/
├── manifest.json
├── package.json                    # "build" script entry, no runtime deps
├── README.md                       # load-unpacked instructions, scope notes
├── icons/{16,32,48,128}.png
├── background/service-worker.js    # flat script, no ES import/export (cross-browser safety)
├── content-scripts/
│   ├── overlay-engine.js           # heuristic MutationObserver engine (core feature)
│   ├── cosmetic-filter.js          # injects <style> from curated selector lists
│   └── popunder-guard.js           # MAIN-world window.open override, blocks clickunder popups (see Finding 4)
├── popup/{popup.html,popup.js,popup.css}
├── rules/
│   ├── domains-source.txt          # curated ad/tracker domains, one per line
│   ├── overlay-selectors.json      # curated CSS selectors for known overlay patterns
│   ├── generic-ad-selectors.json   # curated CSS selectors for generic ad containers
│   ├── build-dnr-rules.js          # Node script: domains-source.txt -> generated/dnr-rules.json
│   └── generated/dnr-rules.json    # build output, checked in, referenced by manifest.json
├── server/issue-proxy/             # backend for the in-popup "Report an issue" form
└── test/overlay-test.html          # dev-only fixture page (not shipped/referenced in manifest)
```

## manifest.json

- `manifest_version: 3`, permissions: `declarativeNetRequest`, `storage`, `tabs`; `host_permissions: ["<all_urls>"]` (required since protection must run proactively on every page, not just on click - document this trade-off in README).
- `background`: dual-key object - `service_worker` (Chrome) + `scripts` (Firefox) both pointing at `background/service-worker.js`. **Do not use ES module `import`/`export`** in that file - flat script avoids module-vs-classic-script cross-browser ambiguity; drop `"type": "module"`.
- `action.default_popup: popup/popup.html`.
- `declarative_net_request.rule_resources`: one static ruleset pointing at `rules/generated/dnr-rules.json`.
- `content_scripts`: `cosmetic-filter.js` + `overlay-engine.js` on `<all_urls>`, `run_at: document_start`, `all_frames: false` (top frame only). This is a real coverage cut, not just a cross-origin limitation: some overlay ads (and their close-button-hijacking scripts) render inside **first-party** iframes too, which this misses. `popunder-guard.js` is the one exception - see Finding 4.
- `browser_specific_settings.gecko.id` set for Firefox loading - a stable value, since changing it later changes the extension's identity for storage/update purposes.
- `browser_specific_settings.gecko.data_collection_permissions`: `required: ["none"]`, `optional: ["technicalAndInteraction", "browsingActivity"]` - matches actual behavior (zero collection for core function; browser/version/page-URL only sent if the user explicitly submits the popup's report form). Requires Firefox 140+, which is why `strict_min_version` is 140, not 128.
- `permissions` does not include `scripting` - audited actual `chrome.scripting.*` usage across the codebase and found none; requesting an unused permission is exactly what store reviewers flag.
- No `web_accessible_resources` needed. Default CSP is sufficient for extension pages (popup/background use no remote scripts or eval).

## Network blocking (declarativeNetRequest)

- `rules/domains-source.txt`: curated plain-text list (a few hundred well-known ad/tracker domains, `#`-commented, hand-picked from public knowledge of common ad networks/trackers - e.g. doubleclick.net, googlesyndication.com, adnxs.com, scorecardresearch.com). Explicitly **not** a full EasyList import.
- `rules/build-dnr-rules.js` (plain Node, no deps): reads the source list, dedupes, emits one DNR block rule per domain using `||domain^` urlFilter syntax, `resourceTypes` excluding `main_frame` (never block a page the user directly navigates to), asserts rule count stays well under DNR limits, writes pretty-printed JSON to `rules/generated/dnr-rules.json`. Checked into repo so unpacked-load works with zero build step; script only reruns when the domain list changes.
- **Firefox DNR parity is not guaranteed** even for this static-rules-only subset - Firefox's `declarativeNetRequest` implementation has historically lagged Chrome's, and a mismatch here can fail silently (rules just don't apply, no error thrown). Confirm as part of first-load verification that Firefox actually honors `rule_resources` the same way Chrome does - don't assume parity because only the "safe" static-rule subset is used.

## Cosmetic filtering (`cosmetic-filter.js`)

- Curated selector lists (`overlay-selectors.json` ~30-60 entries for overlay-specific patterns, `generic-ad-selectors.json` ~50-100 entries for common ad containers like `.adsbygoogle`) inlined as JS constants in the script for synchronous availability at `document_start` (no fetch race).
- Injects one `<style>` tag with `selector1, selector2, ... { display: none !important; }`.
- Skips entirely if globally disabled or current site is whitelisted (checked via `chrome.storage.local` before injecting).

## Overlay heuristic engine (`overlay-engine.js`) - core feature

- **Signals** (weighted, summed into a score): `position: fixed/sticky`, `z-index`, viewport-coverage ratio, body scroll-lock correlated with the element's insertion, delayed appearance after load, ad-keyword substrings in id/class, presence of an ad-network iframe, standard IAB ad-unit size match. A numeric `OAB_HIDE_THRESHOLD` constant triggers hiding once cleared - but see the **confirmation gate** below (added in Finding 6), which is a separate, non-numeric requirement on top of the threshold.
- **Attach timing**: the script runs at `document_start`, where `document.body` does not exist yet. A one-shot `readystatechange`/`DOMContentLoaded` listener (with a `requestAnimationFrame` fallback) attaches the `MutationObserver` to `document.body` only once it exists.
- **MutationObserver**, debounced ~200ms batching, pre-filtered to reasonably-sized block elements (`offsetWidth/Height >= 50`) before scoring. Supplemented by a periodic shallow rescan (catches display-toggle-only overlays that don't add new nodes) on a **decaying schedule** (1s, 3s, 6s, 10s, then stop) rather than a fixed long-running cadence. Paused entirely when the tab is hidden.
- **Hide, not remove**: `element.style.setProperty('display', 'none', 'important')` directly on the element, not an injected class (inline `!important` reliably beats page stylesheet specificity). Reversible, and won't break page JS holding references. Hidden elements are recorded for a same-page "restore hidden elements" popup action.
- **Absolute exclusion**: `document.documentElement` and `document.body` are never eligible candidates, regardless of score or signals - see Finding 8. Elements with (or wrapping) `role="dialog"`/`role="alertdialog"`/`role="listbox"` are excluded the same way - see Findings 11-12 and 14 (the `aria-modal="true"` co-requirement Finding 11 originally added was dropped in Finding 14). Empty `aria-hidden="true"` scrims are excluded too - see Finding 13.
- **Whitelist/enabled short-circuit**: checked first, before attaching any observer - global `enabled` flag and per-site `siteWhitelist` (hostname list) in `chrome.storage.local`.
- **Confirmation gate** (added in Finding 6): clearing `OAB_HIDE_THRESHOLD` is necessary but not sufficient. The element must also trip at least one *distinctive* signal - `scrollLock`, `keyword`, `adIframe`, `standardAdSize`, or the strong z-index tier (`>=9999`, raised from `>=1000` - see Finding 10). Weak/common signals (low z-index, "appeared late", position+coverage alone) do not qualify on their own - see Findings 6-8 for why this exists and its limits. `scrollLock` in particular is a weaker discriminator than it looks - real accessible modals correlate their own insertion with a body scroll-lock just as reliably as a fake nag does, which is exactly what Finding 11 is about.
- **Keyword list is deliberately narrow and evidence-driven**: `paywall` and `overlay` were both removed after being confirmed as false-positive sources (Findings 3 and 7) rather than being generically "ad-related" words. `popup` remains, flagged as carrying similar risk but not yet confirmed as a problem - see Finding 7.
- **`OAB_DEBUG`** constant (off by default): when true, logs the full per-signal score breakdown (not just the summed total) for every evaluated candidate, used throughout the Findings Log to diagnose false positives.

## Messaging & badge

- Content scripts -> background: `OAB_ELEMENT_BLOCKED` (increment), `OAB_COSMETIC_COUNT_SYNC` (absolute count reconcile), via `chrome.runtime.sendMessage`.
- Popup <-> background: `OAB_GET_TAB_STATS` / response; toggle state changes (`enabled`, per-site whitelist) go **directly through `chrome.storage.local` writes from the popup**, with content scripts and background reacting via `chrome.storage.onChanged` - simpler than round-tripping toggles through explicit messages. Reserve `runtime.sendMessage` for count-reporting and the `OAB_RESTORE_HIDDEN` popup-to-content-script action.
- Background keeps an in-memory (mirrored to `chrome.storage.session` where available, falling back to plain in-memory `Map` if unsupported) per-tab counter map, updates `chrome.action.setBadgeText` on change, resets counters on `chrome.tabs.onUpdated` (status `loading`, main frame) and cleans up on `chrome.tabs.onRemoved`.
- **Service-worker restart handling**: on worker startup, explicitly rehydrate the per-tab counter map from `chrome.storage.session` *before* handling any new message or setting a badge - otherwise a restart mid-tab-session shows a stale/zero badge until the next event arrives.
- **Known MV3 limitation**: production builds can't get exact per-request network-block counts (the debug API is dev-mode/unpacked only) - badge/popup counts reflect overlay + cosmetic hides only; network blocking still runs, just isn't counted.

## Storage schema (`chrome.storage.local`)

```js
{
  enabled: true,
  siteWhitelist: ["example.com", ...],   // exact hostnames, MVP simplification
  stats: { totalOverlaysBlocked: 0, totalCosmeticBlocked: 0, installDate: "..." },
  schemaVersion: 1
}
```

Per-tab ephemeral counts in `chrome.storage.session` (or in-memory fallback), keyed by tabId. `schemaVersion` is backed by an actual migration check on background startup, not a decorative field.

## Popup UI

Vanilla HTML/JS/CSS (no framework/bundler): header with global on/off toggle; current-tab hostname with a "paused on this site" toggle; blocked-count display; a "Restore hidden elements on this page" button; a "Report an issue" form that submits directly to GitHub via `server/issue-proxy`. No options page - whitelist pruning UI is the one clear future candidate if ever needed.

## Verification

1. **Load unpacked**: Chrome via `chrome://extensions` -> Developer mode -> Load unpacked (project root). Firefox via `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on (select `manifest.json`).
2. **Cross-browser sanity checks**: confirm a content-script message reliably wakes and is handled by the Firefox background script; confirm Firefox actually applies the static `rule_resources` DNR ruleset the same as Chrome.
3. **Fixture test page** (`test/overlay-test.html`, dev-only, not referenced by manifest): a delayed full-screen fake "disable your ad blocker" overlay with scroll-lock; a sticky-footer nag fixture for mid-range scoring; multiple negative-control fixtures (cookie-consent banner, onboarding modal, paywall) sharing surface signals with real ad overlays but which must remain visible.
4. **Network blocking check**: DevTools Network tab on a real ad-heavy page, confirm requests to curated domains are blocked.
5. **Manual spot-check**: real ad-laden sites to visually confirm overlay/cosmetic removal and toggle/whitelist/restore behavior in the popup.
6. **Live-site regression testing is required for any change to the heuristic engine** - fixture-page testing alone has repeatedly failed to catch real bugs (see Findings 1, 2, 4, 6, 7, 8). [canyoublockit.com/extreme-test](https://canyoublockit.com/extreme-test/) is a safe default target.

## Explicit MVP scope limits

No full EasyList import (curated domain list only); no regex/path filter rules, no `main_frame` network blocking; no cross-origin iframe scanning for `overlay-engine.js`/`cosmetic-filter.js` (`popunder-guard.js` is the exception, see Finding 4); no options page; no exact production network-block counter (platform limitation); no persistent cross-session undo (session-only restore, whitelist toggle is the durable fix); no automated test harness (manual fixture + spot-checks only); detection threshold is a hard-coded constant needing empirical tuning, not user-configurable; no SPA/pushState navigation handling - overlays injected long after the initial load on a client-side route change get zero heuristic coverage, not degraded coverage; counter continuity across service-worker restarts is best-effort, not guaranteed, when `chrome.storage.session` is unavailable.

## Small implementation-time checks (not architecture changes)

- `activeTab` was dropped from `manifest.json` permissions as redundant once `host_permissions: ["<all_urls>"]` is granted.
- DNR rules' `resourceTypes` explicitly includes `sub_frame` (a lot of ad delivery is via ad iframes) while excluding `main_frame`.
- Double-counting guard: an element can simultaneously match a cosmetic CSS selector and clear the heuristic score threshold. `cosmetic-filter.js` tags elements it hides with a data-attribute, and the heuristic engine treats **that marker, not `getComputedStyle(el).display === 'none'`**, as the sole source of truth for its skip check - computed style is also true for elements the page itself legitimately hides.

## Findings Log

Real defects found via live-site testing, in order discovered. Read before changing `overlay-engine.js`, `cosmetic-filter.js`, or `popunder-guard.js`.

### Finding 1: Cross-script namespace collision silently disabled the overlay engine

- Symptom: heuristic engine never ran on any page; badge always read 0, no visible error.
- Cause: both content scripts declared `let oabRescanTimers` in their shared global scope - a fatal `SyntaxError`.
- Fix: prefixed all `cosmetic-filter.js` identifiers with `oabCosmetic`; `oabIsWhitelisted` kept as one shared definition.
- Status: Fixed.

### Finding 2: Coverage-ratio blind spot missed standard-size ad units

- Symptom: a real 728x90 fixed banner ad wasn't detected.
- Cause: its ~7% viewport coverage was under the signal's floor - standard ad sizes are small in absolute pixels.
- Fix: added a standard-IAB-size match signal, independent of coverage %; added "banner"/"bnr" to keywords.
- Status: Fixed.

### Finding 3: False positive from the "paywall" keyword

- Symptom: fixture page's negative-control paywall got hidden.
- Cause: "paywall" was in the ad-keyword list.
- Fix: removed it - also out of scope, since hiding paywalls is bypass, not ad-blocking.
- Status: Fixed.

### Finding 4: Clickunder popunder ads - a new attack class, new file added

- Symptom: clicking play opened a new tab to a rotating scam/ad redirect.
- Cause: a JS click-hijack calling `window.open()` - no DOM element exists to hide.
- Fix: added `popunder-guard.js`, overriding `window.open` in MAIN world, all frames, with `match_origin_as_fallback` (needed for `about:blank` ad frames).
- Status: Fixed - 0/8 popups got through in live trials after the fix.

### Finding 5: canyoublockit.com/extreme-test/ - ad-blocker-circumvention network and a keyword false positive

- Issue A: `adsco.re` proxies ad creative through randomized subdomains faster than a curated domain list can track.
  - Status: Accepted limitation - needs an EasyList-scale filter list, not a domain-list fix.
- Issue B: a legitimate Mopinion survey widget got hidden - its random hex ID tokenized into a spurious "ad" keyword match.
  - Fix: strip long hex runs from id/class before keyword matching.
  - Status: Keyword bug fixed; full false positive fixed by Finding 6.

### Finding 6: Breaking GitHub's own mobile navigation menu

- Symptom: mobile hamburger menu opened internally (icon toggled) but showed no content.
- Cause: `position(3) + coverage(4) = 7` alone cleared the hide threshold with no other signal - true of many legitimate full-screen panels, not just ads.
- Fix: added a confirmation gate requiring one distinctive signal (`scrollLock`, `keyword`, `adIframe`, `standardAdSize`, or z-index >=1000) alongside the score threshold.
- Status: Fixed.

### Finding 7: Confirmation gate loophole - "overlay" as a keyword

- Symptom: GitHub's branch-picker dropdown closed itself within seconds of opening.
- Cause: "overlay" matched Primer's own `Overlay` component class name - generic UI terminology, not a real ad signal.
- Fix: removed "overlay" from the keyword list.
- Status: Fixed.

### Finding 8: The entire page - `<body>` itself - got hidden

- Symptom: reported as "the Firefox bug still exists"; `document.body` was in the hidden-elements list.
- Cause: not Firefox-specific - GitHub's logged-in mobile dialog scroll-locks `<body>`, which trivially "correlates" with its own lock and clears the confirmation gate.
- Fix: unconditionally exclude `document.documentElement`/`document.body` from candidacy - no legitimate ad is ever the document root.
- Status: Fixed.

### Finding 9: A WordPress theme's main content wrapper got hidden, collapsing the page to zero height

- Symptom: on canyoublockit.com/advanced-adblocker-test/alternate-content/, `div#page.hfeed.site` (the theme's outermost content wrapper) got hidden and the whole page collapsed.
- Cause: `coverage(4) + adIframe(2) = 6` cleared the gate despite `position: static` - the two strongest coverage tiers never required `position: fixed`, only the weakest did, so any large ordinary content wrapper on any page got free coverage points; `adIframe` also searches the full subtree with no depth/size limit, so any wrapper containing a real ad iframe anywhere inside it matched.
- Fix: coverage now only counts for `position: fixed` elements at all three tiers - an overlay floats over content, a huge `position: static` wrapper is just the page.
- Status: Fixed. Real ad content on the same page (`#ad_banner` + its iframe) is still correctly blocked via the cosmetic selector list, unaffected by this fix.

### Finding 10: Cloudflare's own dashboard drawer got hidden, blocking a deployment step

- Symptom: a Cloudflare dashboard settings panel wouldn't open while deploying `server/issue-proxy`.
- Cause: `position(3) + zIndex(2, >=1000 tier) + delayed(1) = 6` qualified via z-index alone - Cloudflare's own design system uses z-index 1150 for this legitimate drawer.
- Fix: the qualifying z-index bar raised from >=1000 to only the most extreme tier (>=9999).
- Status: Fixed.

### Finding 11: MUI docs' "Settings" drawer got hidden via the scroll-lock signal

- Symptom: on mui.com/material-ui/all-components/, clicking the toolbar's settings icon opened nothing - the `MuiDrawer-root`/`MuiModal-root` wrapper had `display: none` with `data-oab-hidden-by="heuristic"`.
- Cause: `position(3) + zIndex(2, >=1000 tier) + coverage(4) + scrollLock(3) + delayed(1) = 13`, well past the threshold, and qualified via `scrollLock` - MUI's Modal correctly locks body scroll within the same tick it inserts the modal, exactly the correlation the `scrollLock` signal is designed to detect. Finding 10's z-index fix didn't help here since z-index alone wasn't why it qualified. Any correctly-built accessible modal/drawer (MUI, Radix, Headless UI, Bootstrap, ...) triggers this same combination - `scrollLock` turns out to be a weak discriminator between "real ad nag" and "any modern accessible dialog."
- Fix: added an absolute exclusion (alongside `<body>`/`<html>` from Finding 8) for `role="dialog"`/`role="alertdialog"` + `aria-modal="true"`, on the candidate or a wrapped descendant.
- Status: Fixed.

### Finding 12: Cloudflare's Kumo-design-system Select dropdown got hidden

- Symptom: a Select dropdown on Cloudflare's own dashboard stayed hidden after being opened.
- Cause: same class of issue as Finding 11 - a legitimate widget tripping ad-overlay signals. Element was `role="listbox"`, a distinct ARIA widget pattern real ads don't implement.
- Fix: extended the Finding 11 exclusion (renamed `oabHasAccessibleWidgetSemantics`) to also cover `role="listbox"`.
- Status: Fixed.

### Finding 13: Base UI's inert popup/drawer backdrop got hidden

- Symptom: two more Cloudflare dashboard elements got hidden - an empty full-viewport click-blocker and a drawer's dimming backdrop, both from Base UI's popup internals, siblings of the actual popup rather than wrappers around it (so Finding 12's exclusion never saw them).
- Cause: both were `position: fixed; inset: 0`, correctly marked `aria-hidden="true"` and empty of text - a real ad nag is never empty of content, since its entire purpose is to be read.
- Fix: new exclusion for `aria-hidden="true"` elements with no text content (`oabIsDecorativeAriaHiddenScrim`).
- Status: Fixed.

### Finding 14: a real dialog without aria-modal slipped past the Finding 11 exclusion

- Symptom: Cloudflare's "Connect to a repository" drawer stayed hidden after opening.
- Cause: `role="dialog"` was present, but not `aria-modal="true"` - Finding 11's exclusion required both, and real dialogs don't reliably set the latter.
- Fix: dropped the `aria-modal="true"` co-requirement; `role="dialog"`/`"alertdialog"`/`"listbox"` alone is now sufficient.
- Status: Fixed.
