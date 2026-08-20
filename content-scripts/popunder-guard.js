// Popunder guard - blocks scripted cross-origin new tabs opened via window.open,
// blank-open-then-navigate, <a target=_blank>.click() and form.submit().
// MAIN world, all frames. See plan.md Finding 4.

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

  // A blank/absent target is fine - it is the later navigation that matters,
  // and that goes back through this same check.
  function oabNavigationAllowed(url) {
    if (!url) return true;
    const str = String(url);
    if (str === 'about:blank' || str.indexOf('#') === 0) return true;
    return oabIsSameOrigin(str) || oabIsAllowlisted(str);
  }

  function oabRefuse(url, win) {
    console.warn('[overlay-ad-blocker] blocked a cross-origin popup:', String(url));
    if (win) {
      try { win.close(); } catch (e) { /* already gone or not ours to close */ }
    }
  }

  // window.location is [Unforgeable], so vet a blank popup's destination by
  // handing back a Proxy with a stand-in location. Everything else forwards
  // through, keeping w.document.write() and other legitimate uses working.
  function oabWrapPopup(realWin) {
    if (!realWin) return realWin;

    const navigate = (value, apply) => {
      if (oabNavigationAllowed(value)) {
        try { apply(); } catch (e) { /* window closed underneath us */ }
      } else {
        oabRefuse(value, realWin);
      }
    };

    const stand_in = {
      get href() {
        try { return realWin.location.href; } catch (e) { return ''; }
      },
      set href(v) { navigate(v, () => { realWin.location.href = v; }); },
      assign(v) { navigate(v, () => { realWin.location.assign(v); }); },
      replace(v) { navigate(v, () => { realWin.location.replace(v); }); },
      reload() { try { realWin.location.reload(); } catch (e) { /* no-op */ } },
      toString() {
        try { return String(realWin.location); } catch (e) { return ''; }
      }
    };

    try {
      return new Proxy(realWin, {
        get(target, prop) {
          if (prop === 'location') return stand_in;
          try {
            const value = Reflect.get(target, prop);
            // Methods must stay bound to the real window, not the Proxy.
            return typeof value === 'function' ? value.bind(target) : value;
          } catch (e) {
            return undefined; 
          }
        },
        set(target, prop, value) {
          if (prop === 'location') {
            navigate(value, () => { target.location = value; });
            return true;
          }
          try { Reflect.set(target, prop, value); } catch (e) { /* read-only or cross-origin */ }
          return true;
        }
      });
    } catch (e) {
      return realWin; // Proxy unavailable - better a working popup than a throw
    }
  }

  // --- Vector 1 + 2: window.open ------------------------------------------
  const oabOriginalOpen = window.open;

  window.open = function (url, target, features) {
    try {
      if (!oabGuardEnabled()) {
        return oabOriginalOpen.call(window, url, target, features);
      }
      if (url && !oabIsSameOrigin(url) && !oabIsAllowlisted(url)) {
        oabRefuse(url, null);
        return null;
      }
      const opened = oabOriginalOpen.call(window, url, target, features);
      // Only blank opens need watching; one given a real same-origin URL is
      // handed back untouched so ordinary popups behave exactly as before.
      if (!url || String(url) === 'about:blank') return oabWrapPopup(opened);
      return opened;
    } catch (e) {
      // Never let a bug in this guard break legitimate popups.
      return oabOriginalOpen.call(window, url, target, features);
    }
  };

  // --- Vector 3: scripted click on <a target="_blank"> ---------------------
  // Capture phase so we run before the page's own handlers. isTrusted is the
  // whole discriminator here: a person clicking a link is always allowed.
  document.addEventListener(
    'click',
    function (event) {
      try {
        if (!oabGuardEnabled() || event.isTrusted) return;
        const node = event.target;
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        const anchor = el && el.closest ? el.closest('a[target]') : null;
        if (!anchor) return;
        if (String(anchor.target).toLowerCase() !== '_blank') return;
        const href = anchor.getAttribute('href');
        if (!href || oabNavigationAllowed(href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        oabRefuse(href, null);
      } catch (e) { /* never break a real click */ }
    },
    true
  );

  // --- Vector 4: form.submit() with target="_blank" ------------------------
  // Calling submit() programmatically fires no submit event, so the listener
  // above cannot see it - the method itself has to be wrapped.
  try {
    const oabOriginalSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      try {
        if (oabGuardEnabled() && String(this.target).toLowerCase() === '_blank') {
          const action = this.getAttribute('action');
          if (action && !oabNavigationAllowed(action)) {
            oabRefuse(action, null);
            return;
          }
        }
      } catch (e) { /* fall through to the real submit */ }
      return oabOriginalSubmit.call(this);
    };
  } catch (e) { /* prototype frozen - nothing to do */ }
})();
