/**
 * Generic + overlay-precision cosmetic ad hiding.
 *
 * Runs at document_start. Injects a single <style> rule built from two
 * curated selector lists (kept in sync by hand with rules/overlay-selectors.json
 * and rules/generic-ad-selectors.json - those JSON files are the documentation
 * source of truth; these are the live copies, inlined for synchronous
 * availability with no fetch race at document_start).
 *
 * This file and content-scripts/overlay-engine.js are loaded into the same
 * content-script world (see manifest.json content_scripts order), so the
 * OAB_MARKER_ATTR constant declared here is visible to overlay-engine.js too
 * - used to dedupe so an element hidden by CSS here is never re-scored (and
 * double-counted) by the heuristic engine. See plan.md "Small
 * implementation-time checks".
 */

const OAB_MARKER_ATTR = 'data-oab-hidden-by';

const OAB_OVERLAY_SELECTORS = [
  'div[id*="onclickads"]',
  'div[class*="onclickads"]',
  'div[id*="adblock-modal"]',
  'div[class*="adblock-modal"]',
  'div[id*="adblock-overlay"]',
  'div[class*="adblock-overlay"]',
  'div[id*="adblock-detected"]',
  'div[class*="adblock-detected"]',
  'div[class*="adblock-notice"]',
  'div[id*="anti-adblock"]',
  'div[class*="anti-adblock"]',
  'div[class*="blockadblock"]',
  'div[id*="blockadblock"]',
  'div[class*="pardon-overlay"]',
  'div[class*="overlay-ad"]',
  'div[id*="overlay-ad"]',
  'div[class*="ad-overlay"]',
  'div[id*="ad-overlay"]',
  'div[class*="ad-interstitial"]',
  'div[id*="ad-interstitial"]',
  'div[class*="interstitial-ad"]',
  'div[class*="popup-ad"]',
  'div[id*="popup-ad"]',
  'div[class*="ad-popup"]',
  'div[class*="modal-ad"]',
  'div[id*="modal-ad"]',
  'div[class*="sp_message_container"]',
  'div[id*="sp_message_container"]',
  'div[class*="ezmob-footer"]',
  'div[id*="ezmob-footer"]',
  'div[class*="propeller-overlay"]',
  'div[class*="exoclick-overlay"]',
  'div[class*="fullscreen-ad"]',
  'div[id*="fullscreen-ad"]',
  'div[class*="take-over-ad"]',
  'div[class*="takeover-ad"]',
  'div[class*="sticky-ad-overlay"]',
  'div[class*="video-overlay-ad"]'
];

const OAB_GENERIC_AD_SELECTORS = [
  'ins.adsbygoogle',
  '.adsbygoogle',
  'div[id^="google_ads_iframe"]',
  'div[id^="div-gpt-ad"]',
  'div[id^="google_ads_frame"]',
  'iframe[id^="google_ads_iframe"]',
  'iframe[id^="aswift_"]',
  '.ad-banner',
  '#ad-banner',
  '.ad-container',
  '#ad-container',
  '.ad-wrapper',
  '#ad-wrapper',
  '.ad-slot',
  '#ad-slot',
  '.advertisement',
  '#advertisement',
  '.advert',
  '#advert',
  '.sponsored-content',
  '[class*="sponsored-content"]',
  '[class*="sponsored-post"]',
  '[class*="native-ad"]',
  '[id*="native-ad"]',
  'div[id^="ad_"]',
  'div[class^="ad-"]',
  'div[class="ad"]',
  'div[id="ad"]',
  'div[class*=" ad "]',
  'aside[class*="ad"]',
  '.banner-ad',
  '#banner-ad',
  '.top-ad',
  '.bottom-ad',
  '.side-ad',
  '.sidebar-ad',
  '.in-content-ad',
  '.inline-ad',
  '.header-ad',
  '.footer-ad',
  '.taboola',
  '#taboola-below-article-thumbnails',
  'div[id^="taboola-"]',
  '.outbrain',
  'div[id^="outbrain_widget"]',
  '.OUTBRAIN',
  '.mgid-widget',
  'div[id^="mgid"]',
  '.zergnet-widget',
  'div[id^="zergnet"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="criteo.com"]',
  '.pub_300x250',
  '.pub_300x250m',
  '.pub_728x90',
  '.text-ad',
  '.text-ad-links',
  '[class*="ad-slot-"]',
  '[id*="ad-slot-"]',
  '[class*="adslot"]',
  '[id*="adslot"]'
];

const OAB_ALL_SELECTORS = OAB_OVERLAY_SELECTORS.concat(OAB_GENERIC_AD_SELECTORS);
const OAB_JOINED_SELECTOR = OAB_ALL_SELECTORS.join(',\n');

// NOTE ON NAMING: this file and overlay-engine.js are loaded into the same
// content-script global scope (see manifest.json content_scripts order), so
// every top-level `let`/`const`/`function` identifier here MUST be unique
// across both files - a duplicate `let`/`const` throws a fatal SyntaxError
// that silently kills the *other* script's entire execution (found the hard
// way during live-site testing: both files originally declared their own
// `oabRescanTimers`, which crashed overlay-engine.js on every page). Hence
// the `oabCosmetic` prefix below, distinct from overlay-engine.js's `oab`
// prefix. `oabIsWhitelisted` is the one deliberately shared exception -
// defined once, here, since this file loads first.

let oabCosmeticStyleEl = null;
let oabCosmeticRescanTimers = [];

function oabCosmeticInjectStyle() {
  if (oabCosmeticStyleEl) return;
  oabCosmeticStyleEl = document.createElement('style');
  oabCosmeticStyleEl.setAttribute('data-oab-cosmetic-style', 'true');
  oabCosmeticStyleEl.textContent = `${OAB_JOINED_SELECTOR} {\n  display: none !important;\n}`;
  (document.documentElement || document.head || document.body).appendChild(oabCosmeticStyleEl);
}

function oabCosmeticRemoveStyle() {
  if (oabCosmeticStyleEl && oabCosmeticStyleEl.parentNode) {
    oabCosmeticStyleEl.parentNode.removeChild(oabCosmeticStyleEl);
  }
  oabCosmeticStyleEl = null;
}

function oabCosmeticTagAndCount() {
  if (!oabCosmeticStyleEl) return;
  let count = 0;
  try {
    const matches = document.querySelectorAll(OAB_JOINED_SELECTOR);
    for (const el of matches) {
      // Mark as the source of truth for cross-script dedupe (see file header).
      if (!el.hasAttribute(OAB_MARKER_ATTR)) {
        el.setAttribute(OAB_MARKER_ATTR, 'cosmetic');
      }
      count++;
    }
  } catch (err) {
    // A malformed selector should never take down the whole content script.
    console.warn('[overlay-ad-blocker] cosmetic selector query failed:', err);
  }
  chrome.runtime.sendMessage({ type: 'OAB_COSMETIC_COUNT_SYNC', count });
}

function oabCosmeticScheduleRescans() {
  oabCosmeticClearRescans();
  // Decaying schedule rather than a long fixed-cadence loop - generic ad
  // containers are mostly present at/near load, so a few passes is enough.
  for (const delayMs of [300, 1000, 3000, 6000, 10000]) {
    oabCosmeticRescanTimers.push(setTimeout(oabCosmeticTagAndCount, delayMs));
  }
}

function oabCosmeticClearRescans() {
  for (const t of oabCosmeticRescanTimers) clearTimeout(t);
  oabCosmeticRescanTimers = [];
}

function oabCosmeticApplyState(enabled, whitelisted) {
  const active = enabled && !whitelisted;

  if (active) {
    oabCosmeticInjectStyle();
    oabCosmeticScheduleRescans();
  } else {
    oabCosmeticRemoveStyle();
    oabCosmeticClearRescans();
  }

  // Bridge to content-scripts/popunder-guard.js, which runs in the page's
  // MAIN world and therefore has no chrome.storage access of its own - see
  // that file's header comment for why this attribute is the hand-off
  // point. documentElement always exists by document_start, even before
  // <body>, so this is safe to call immediately.
  document.documentElement.setAttribute('data-oab-enabled', String(active));
}

function oabIsWhitelisted(siteWhitelist) {
  const list = Array.isArray(siteWhitelist) ? siteWhitelist : [];
  return list.includes(location.hostname);
}

function oabCosmeticInit() {
  chrome.storage.local.get(['enabled', 'siteWhitelist'], (result) => {
    const enabled = result.enabled !== false; // default true if unset
    const whitelisted = oabIsWhitelisted(result.siteWhitelist);
    oabCosmeticApplyState(enabled, whitelisted);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!('enabled' in changes) && !('siteWhitelist' in changes)) return;
  chrome.storage.local.get(['enabled', 'siteWhitelist'], (result) => {
    const enabled = result.enabled !== false;
    const whitelisted = oabIsWhitelisted(result.siteWhitelist);
    oabCosmeticApplyState(enabled, whitelisted);
  });
});

oabCosmeticInit();
