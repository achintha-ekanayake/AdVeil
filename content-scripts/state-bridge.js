/**
 * Guard state bridge - mirrors the enabled/whitelist decision onto
 * data-oab-enabled in EVERY frame, cross-origin subframes included.
 *
 * popunder-guard.js runs in the MAIN world in all frames and reads that
 * attribute off its own document. The cosmetic scripts are top-frame only
 * (all_frames: false), so before this file existed the attribute was simply
 * absent inside iframes and oabGuardEnabled() fell through to its fail-safe
 * default of ON - meaning "pause on this site" and the global off switch did
 * not actually stop the guard in framed content.
 *
 * A subframe cannot see the top-level hostname (cross-origin), so the
 * whitelist decision for one is resolved by the service worker, which has
 * sender.tab.url. The top frame answers it locally from storage - same read
 * the cosmetic filter does, no round trip on the common path.
 *
 * IIFE-wrapped: content scripts share one isolated world per frame, so
 * top-level names here would collide with the cosmetic/overlay scripts
 * (see plan.md Finding 1).
 */

(function () {
  'use strict';

  const OAB_ENABLED_ATTR = 'data-oab-enabled';

  function oabBridgeApply(active) {
    const root = document.documentElement;
    if (root) root.setAttribute(OAB_ENABLED_ATTR, String(active));
  }

  function oabBridgeIsWhitelisted(siteWhitelist, hostname) {
    const list = Array.isArray(siteWhitelist) ? siteWhitelist : [];
    return list.includes(hostname);
  }

  function oabBridgeRefresh() {
    try {
      // Cross-origin safe: comparing WindowProxy identity never throws.
      if (window.top === window) {
        chrome.storage.local.get(['enabled', 'siteWhitelist'], (result) => {
          if (chrome.runtime.lastError) return;
          const enabled = result.enabled !== false; // default true if unset
          oabBridgeApply(enabled && !oabBridgeIsWhitelisted(result.siteWhitelist, location.hostname));
        });
        return;
      }

      chrome.runtime.sendMessage({ type: 'OAB_GET_GUARD_STATE' }, (response) => {
        // A sleeping/restarting service worker sets lastError. Leaving the
        // attribute unset is correct here - the guard's own default is ON.
        if (chrome.runtime.lastError || !response) return;
        oabBridgeApply(response.active !== false);
      });
    } catch (e) {
      // Extension context invalidated (reload/update) - nothing to mirror.
    }
  }

  oabBridgeRefresh();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!('enabled' in changes) && !('siteWhitelist' in changes)) return;
    oabBridgeRefresh();
  });
})();
