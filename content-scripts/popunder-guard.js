/**
 * Popunder / "clickunder" guard.
 *
 * Found via live testing (see plan.md "Live-testing findings"): some sites
 * hijack the FIRST click anywhere on the page (or on a player) with a JS
 * listener that calls window.open() to a rotating ad/gambling/scam
 * destination - a "clickunder" ad, named that by the ad networks that sell
 * it. There is no DOM element to hide for this pattern (no overlay div is
 * necessarily involved at all - it can be a bare document-level click
 * listener), so the hiding-based mechanisms in overlay-engine.js and
 * cosmetic-filter.js cannot address it. This requires intercepting the
 * browser API the attack depends on: window.open.
 *
 * MUST run in the page's own ("MAIN") JS world, not the extension's
 * isolated content-script world - window.open in the isolated world is a
 * DIFFERENT function object than the page's own window.open, so overriding
 * it there would have no effect on the page's ad script. See manifest.json
 * content_scripts entry with "world": "MAIN" for this file specifically.
 *
 * Runs in EVERY frame (all_frames: true), unlike overlay-engine.js and
 * cosmetic-filter.js (all_frames: false). Confirmed via live testing that
 * this matters: a real clickunder ad on a streaming site fired from inside
 * a cross-origin embedded video-player iframe, which has its OWN window.open
 * - patching only the top frame's left it completely unprotected. This
 * script is cheap (one function override, no DOM scanning), so the
 * per-frame cost is negligible, unlike the heavier scripts.
 *
 * Also declares "match_origin_as_fallback": true. Without it, Chrome/Firefox
 * do NOT inject content scripts into about:blank / about:srcdoc frames at
 * all, regardless of all_frames - and that's exactly where a lot of ad-tag
 * script actually executes (dynamically created iframe, content written in
 * via document.write, no real URL of its own to match against). Confirmed
 * via live testing: the clickunder still fired from an about:blank ad-tag
 * frame even after all_frames: true alone; this flag was the missing piece.
 *
 * Scripts in the MAIN world do NOT have access to chrome.* extension APIs
 * (no chrome.storage, no chrome.runtime) - that's a hard platform
 * restriction, not an oversight. To still respect the global enabled flag
 * and per-site whitelist, cosmetic-filter.js (isolated world, which DOES
 * have chrome.storage access) writes the resolved state onto
 * document.documentElement as a data attribute; this script reads that
 * attribute at call-time on every window.open invocation. See
 * OAB_ENABLED_ATTR below and cosmetic-filter.js's oabCosmeticApplyState.
 *
 * KNOWN GAP: that attribute bridge only exists in frames where
 * cosmetic-filter.js also runs - i.e. only the top frame (all_frames:
 * false there). Inside sub-frames, this script always sees the attribute
 * missing and falls back to its safe default (blocking active), regardless
 * of the user's global enabled toggle or per-site whitelist. This is
 * intentional-by-necessity, not an oversight: whitelisting a site to stop
 * cosmetic/overlay hiding should not also have to disarm popup blocking
 * inside an embedded third-party iframe. If this default ever needs to be
 * overridable per sub-frame, it requires wiring an isolated-world script
 * into all_frames too, just to relay storage state - not done for MVP.
 */

(function () {
  'use strict';

  const OAB_ENABLED_ATTR = 'data-oab-enabled';

  // Cross-origin popups that are common, legitimate flows (auth/payment)
  // rather than ad redirects. Deliberately short and specific - this is a
  // known trade-off (see plan.md): blocking ALL cross-origin window.open
  // calls is the standard mitigation for clickunder ads, but it can also
  // catch legitimate popup-based flows this allowlist doesn't happen to
  // cover. Extend as real breakage is reported, don't grow it speculatively.
  const OAB_POPUP_ALLOWLIST_HOSTS = [
    'accounts.google.com',
    'appleid.apple.com',
    'login.microsoftonline.com',
    'login.live.com',
    'www.paypal.com',
    'checkout.stripe.com',
    'js.stripe.com',
    'www.facebook.com',
    'twitter.com',
    'x.com',
    'github.com',
    'discord.com'
  ];

  function oabGuardEnabled() {
    const attr = document.documentElement.getAttribute(OAB_ENABLED_ATTR);
    // Default to protection ON if the isolated-world script hasn't resolved
    // its storage read yet - matches the extension's "enabled by default"
    // posture elsewhere, and errs toward blocking a scam redirect over
    // letting one through during the brief window before storage resolves.
    return attr !== 'false';
  }

  function oabIsSameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return true; // can't parse it - don't block what we can't evaluate
    }
  }

  function oabIsAllowlisted(url) {
    try {
      const hostname = new URL(url, location.href).hostname;
      return OAB_POPUP_ALLOWLIST_HOSTS.some(
        (h) => hostname === h || hostname.endsWith('.' + h)
      );
    } catch (e) {
      return false;
    }
  }

  const oabOriginalOpen = window.open;

  window.open = function (url, target, features) {
    try {
      if (!oabGuardEnabled() || !url || oabIsSameOrigin(url) || oabIsAllowlisted(url)) {
        return oabOriginalOpen.call(window, url, target, features);
      }
      console.warn('[overlay-ad-blocker] blocked a cross-origin popup:', url);
      return null;
    } catch (e) {
      // Never let a bug in this guard break legitimate popups.
      return oabOriginalOpen.call(window, url, target, features);
    }
  };
})();
