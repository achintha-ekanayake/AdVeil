/**
 * Popunder/"clickunder" guard - some sites hijack the first click to call
 * window.open() on a scam/ad redirect, with no DOM element to hide. Runs in
 * MAIN world, every frame incl. about:blank ad frames. See plan.md Finding 4.
 */

(function () {
  'use strict';

  const OAB_ENABLED_ATTR = 'data-oab-enabled';

  // Common legitimate cross-origin popup flows (auth/payment). Deliberately
  // short - extend only as real breakage is reported, not speculatively.
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
    // Default ON before the isolated-world storage read resolves - errs
    // toward blocking a scam redirect over letting one through.
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
