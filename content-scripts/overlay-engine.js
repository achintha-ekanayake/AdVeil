/**
 * Heuristic overlay-ad detection engine - scores DOM elements on position,
 * z-index, coverage, scroll-lock, delay, keywords, and ad-iframe presence.
 * Relies on OAB_MARKER_ATTR from cosmetic-filter.js (loads first) to skip
 * elements already hidden there. See plan.md Findings Log for why.
 */

// Flip on manually during development to see the per-signal score breakdown
// for every evaluated candidate in the console. Keep off for shipped builds.
const OAB_DEBUG = false;

const OAB_HIDE_THRESHOLD = 6;

const OAB_MIN_CANDIDATE_SIZE = 50; // px, both width and height, pre-filter

// "paywall" and "overlay" deliberately excluded - both caused false
// positives (a legitimate paywall, and framework "Overlay" components like
// GitHub's dropdowns). See plan.md Findings 3 and 7 before re-adding either.
const OAB_AD_KEYWORDS = [
  'ad', 'ads', 'advert', 'sponsor', 'sponsored', 'promo',
  'interstitial', 'popup', 'adblock', 'nag',
  'banner', 'bnr'
];

const OAB_AD_IFRAME_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'adnxs.com',
  'amazon-adsystem.com', 'criteo.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'taboola.com', 'outbrain.com',
  'adform.net', 'smartadserver.com', 'appnexus.com'
];

// Standard IAB ad sizes are small in absolute pixels, so viewport-%
// coverage alone misses them (a 728x90 banner is ~7% of a 1280x720
// screen). See plan.md Finding 2.
const OAB_STANDARD_AD_SIZES = [
  [728, 90], [970, 250], [970, 90], [320, 50], [320, 100],
  [300, 250], [336, 280], [300, 600], [300, 50], [250, 250],
  [200, 200], [468, 60], [234, 60], [160, 600], [120, 600], [120, 240]
];
const OAB_STANDARD_AD_SIZE_TOLERANCE_PX = 4;

function oabMatchesStandardAdSize(width, height) {
  return OAB_STANDARD_AD_SIZES.some(
    ([w, h]) =>
      Math.abs(width - w) <= OAB_STANDARD_AD_SIZE_TOLERANCE_PX &&
      Math.abs(height - h) <= OAB_STANDARD_AD_SIZE_TOLERANCE_PX
  );
}

const OAB_DELAYED_APPEARANCE_MS = 1500;
const OAB_SCROLL_LOCK_CORRELATION_MS = 1500;
const OAB_DEBOUNCE_MS = 200;
const OAB_RESCAN_DELAYS_MS = [1000, 3000, 6000, 10000];

// --- State -------------------------------------------------------------------

let oabEnabledForPage = false;
let oabPageLoadTime = Date.now();
let oabObserver = null;
let oabPending = new Set();
let oabDebounceTimer = null;
let oabRescanTimers = [];
let oabBodyScrollLocked = false;
let oabScrollLockChangedAt = 0;
let oabNextHiddenId = 1;
// hiddenId -> { el, originalDisplayValue, originalDisplayPriority }
const oabHiddenRegistry = new Map();
const oabFirstSeenAt = new WeakMap();

// Declared once in cosmetic-filter.js (loads first, same global scope) -
// not redefined here. Duplicate top-level names across these two files
// have caused fatal crashes before; see plan.md Finding 1.

// --- Signal helpers ------------------------------------------------------

function oabViewportCoverageRatio(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
  const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  return (visibleW * visibleH) / (vw * vh);
}

// Strips long hex runs (e.g. auto-generated IDs) before keyword matching,
// so a hash like "...9ad6..." can't tokenize into a spurious "ad" match.
// See plan.md Finding 5.
const OAB_HEX_RUN_RE = /[0-9a-f]{8,}/gi;

function oabMatchesAdKeyword(id, className) {
  const strip = (s) => (s || '').replace(OAB_HEX_RUN_RE, ' ');
  const raw = `${strip(id)} ${typeof className === 'string' ? strip(className) : ''}`.toLowerCase();
  const normalized = raw.replace(/[^a-z]+/g, ' ');
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.some((tok) => OAB_AD_KEYWORDS.includes(tok));
}

function oabContainsAdIframe(el) {
  const iframes = el.querySelectorAll ? el.querySelectorAll('iframe[src]') : [];
  for (const frame of iframes) {
    const src = frame.getAttribute('src') || '';
    if (OAB_AD_IFRAME_HOSTS.some((host) => src.includes(host))) return true;
  }
  return false;
}

// role="dialog"/"alertdialog"/"listbox", on the candidate or a wrapped
// descendant - real ads don't bother with these. aria-modal="true" used to
// be required alongside dialog/alertdialog, but real dialogs don't reliably
// set it (see Finding 14) - role alone is enough. See also Findings 11-12.
const OAB_ACCESSIBLE_WIDGET_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="listbox"]';

function oabHasAccessibleWidgetSemantics(el) {
  if (el.matches && el.matches(OAB_ACCESSIBLE_WIDGET_SELECTOR)) return true;
  return !!(el.querySelector && el.querySelector(OAB_ACCESSIBLE_WIDGET_SELECTOR));
}

// aria-hidden="true" + no text content: a decorative interaction-blocking
// scrim/backdrop (e.g. a popup or drawer's inert backdrop), not an ad - a
// real nag always has visible persuasive text. See Finding 13.
function oabIsDecorativeAriaHiddenScrim(el) {
  return el.getAttribute('aria-hidden') === 'true' && el.textContent.trim() === '';
}

function oabScoreElement(el) {
  const style = getComputedStyle(el);
  const signals = {};
  let score = 0;

  if (style.position === 'fixed') {
    signals.position = 3;
  } else if (style.position === 'sticky') {
    signals.position = 1;
  } else {
    signals.position = 0;
  }
  score += signals.position;

  const z = parseInt(style.zIndex, 10);
  if (!isNaN(z)) {
    if (z >= 9999) signals.zIndex = 3;
    else if (z >= 1000) signals.zIndex = 2;
    else if (z >= 100) signals.zIndex = 1;
    else signals.zIndex = 0;
  } else {
    signals.zIndex = 0;
  }
  score += signals.zIndex;

  // Coverage only counts for fixed elements - an overlay floats over
  // content; a huge position:static wrapper is just the page. See
  // plan.md Finding 9 (a WordPress #page wrapper scored 6 without this).
  const coverage = oabViewportCoverageRatio(el);
  const isFixed = style.position === 'fixed';
  if (isFixed && coverage >= 0.6) signals.coverage = 4;
  else if (isFixed && coverage >= 0.3) signals.coverage = 2;
  else if (isFixed && coverage >= 0.15) signals.coverage = 1;
  else signals.coverage = 0;
  score += signals.coverage;

  // Standard IAB ad size, fixed/sticky positioned: strong signal on its
  // own, independent of coverage % (see OAB_STANDARD_AD_SIZES above).
  const rectForSize = el.getBoundingClientRect();
  const isFixedish = style.position === 'fixed' || style.position === 'sticky';
  signals.standardAdSize =
    isFixedish && oabMatchesStandardAdSize(rectForSize.width, rectForSize.height) ? 3 : 0;
  score += signals.standardAdSize;

  const firstSeen = oabFirstSeenAt.get(el) || Date.now();
  const scrollLockCorrelated =
    oabBodyScrollLocked &&
    Math.abs(firstSeen - oabScrollLockChangedAt) <= OAB_SCROLL_LOCK_CORRELATION_MS;
  signals.scrollLock = scrollLockCorrelated ? 3 : 0;
  score += signals.scrollLock;

  const msSinceLoad = firstSeen - oabPageLoadTime;
  signals.delayed = msSinceLoad > OAB_DELAYED_APPEARANCE_MS ? 1 : 0;
  score += signals.delayed;

  signals.keyword = oabMatchesAdKeyword(el.id, el.className) ? 1 : 0;
  score += signals.keyword;

  signals.adIframe = oabContainsAdIframe(el) ? 2 : 0;
  score += signals.adIframe;

  // Score alone isn't enough - position+coverage used to clear threshold
  // with no other signal, hiding legitimate full-screen UI (nav drawers,
  // dropdowns). Require one distinctive signal too. See plan.md Findings 6-9.
  // z-index >=1000 (tier 2) was dropped from this list - design systems
  // (Bootstrap, Cloudflare's own dashboard) routinely use 1000-2000 for
  // legitimate drawers/modals. Only the extreme >=9999 tier still qualifies.
  const qualifies =
    signals.scrollLock > 0 ||
    signals.keyword > 0 ||
    signals.adIframe > 0 ||
    signals.standardAdSize > 0 ||
    signals.zIndex >= 3; // only the >=9999 tier

  if (OAB_DEBUG) {
    console.log('[overlay-ad-blocker]', JSON.stringify({
      score, qualifies, signals, id: el.id, className: typeof el.className === 'string' ? el.className : null
    }));
  }

  return { score, qualifies };
}

// --- Hide / restore --------------------------------------------------------

function oabHideElement(el, score) {
  if (el.hasAttribute('data-oab-hidden-by')) return; // already handled

  // Defense in depth - oabIsEligibleCandidate already excludes <html>/<body>,
  // but hiding either blanks the whole page, so refuse here too.
  if (el === document.documentElement || el === document.body) return;

  const priorValue = el.style.getPropertyValue('display');
  const priorPriority = el.style.getPropertyPriority('display');

  el.style.setProperty('display', 'none', 'important');
  el.setAttribute('data-oab-hidden-by', 'heuristic');

  const hiddenId = oabNextHiddenId++;
  el.setAttribute('data-oab-restore-id', String(hiddenId));
  oabHiddenRegistry.set(hiddenId, {
    el,
    originalDisplayValue: priorValue,
    originalDisplayPriority: priorPriority
  });

  // Cap how much history we keep for the session-only restore action.
  if (oabHiddenRegistry.size > 20) {
    const oldestKey = oabHiddenRegistry.keys().next().value;
    oabHiddenRegistry.delete(oldestKey);
  }

  chrome.runtime.sendMessage({ type: 'OAB_ELEMENT_BLOCKED', source: 'overlay-engine', count: 1 });

  // An overlay is often paired with a body scroll-lock the page applied
  // itself; once the overlay is gone, restore normal scrolling too.
  if (oabBodyScrollLocked) {
    document.documentElement.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow');
  }

  if (OAB_DEBUG) {
    console.log('[overlay-ad-blocker] HID element (score', score, ')', el);
  }
}

function oabRestoreAll() {
  for (const { el, originalDisplayValue, originalDisplayPriority } of oabHiddenRegistry.values()) {
    if (!el.isConnected) continue;
    if (originalDisplayValue) {
      el.style.setProperty('display', originalDisplayValue, originalDisplayPriority);
    } else {
      el.style.removeProperty('display');
    }
    el.removeAttribute('data-oab-hidden-by');
    el.removeAttribute('data-oab-restore-id');
  }
  oabHiddenRegistry.clear();
}

// --- Candidate evaluation --------------------------------------------------

function oabIsEligibleCandidate(el) {
  if (!(el instanceof Element)) return false;
  // No legitimate ad is ever the document root. Hiding <body>/<html> once
  // blanked an entire real page (see plan.md Finding 8) - exclude unconditionally.
  if (el === document.documentElement || el === document.body) return false;
  if (el.hasAttribute('data-oab-hidden-by')) return false; // dedupe (incl. cosmetic-filter hits)
  if (oabHasAccessibleWidgetSemantics(el)) return false; // see Findings 11-12
  if (oabIsDecorativeAriaHiddenScrim(el)) return false; // see Finding 13
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return w >= OAB_MIN_CANDIDATE_SIZE && h >= OAB_MIN_CANDIDATE_SIZE;
}

function oabEvaluateCandidate(el) {
  if (!oabFirstSeenAt.has(el)) {
    oabFirstSeenAt.set(el, Date.now());
  }
  if (!oabIsEligibleCandidate(el)) return;
  const { score, qualifies } = oabScoreElement(el);
  if (score >= OAB_HIDE_THRESHOLD && qualifies) {
    oabHideElement(el, score);
  }
}

function oabFlushPending() {
  const batch = oabPending;
  oabPending = new Set();
  for (const el of batch) {
    oabEvaluateCandidate(el);
  }
}

function oabScheduleFlush() {
  if (oabDebounceTimer) clearTimeout(oabDebounceTimer);
  oabDebounceTimer = setTimeout(oabFlushPending, OAB_DEBOUNCE_MS);
}

// --- Scroll-lock tracking ----------------------------------------------------

function oabIsScrollLocked() {
  const htmlOverflow = getComputedStyle(document.documentElement).overflow;
  const bodyOverflow = document.body ? getComputedStyle(document.body).overflow : 'visible';
  return htmlOverflow === 'hidden' || bodyOverflow === 'hidden';
}

function oabCheckScrollLock() {
  const locked = oabIsScrollLocked();
  if (locked !== oabBodyScrollLocked) {
    oabBodyScrollLocked = locked;
    oabScrollLockChangedAt = Date.now();
  }
}

// --- Observer setup ----------------------------------------------------------

function oabHandleMutations(mutations) {
  oabCheckScrollLock();
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) oabPending.add(node);
      }
    } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
      oabPending.add(mutation.target);
    }
  }
  if (oabPending.size > 0) oabScheduleFlush();
}

function oabAttachObserver() {
  if (oabObserver || !document.body) return;
  oabObserver = new MutationObserver(oabHandleMutations);
  oabObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });
  oabCheckScrollLock();
}

function oabWaitForBodyThenAttach() {
  if (document.body) {
    oabAttachObserver();
    return;
  }
  const raf = () => {
    if (document.body) {
      oabAttachObserver();
    } else {
      requestAnimationFrame(raf);
    }
  };
  document.addEventListener('DOMContentLoaded', oabAttachObserver, { once: true });
  requestAnimationFrame(raf);
}

// --- Periodic shallow rescan (decaying schedule, not a long fixed loop) ----

function oabShallowRescan() {
  if (document.hidden) return; // paused while tab isn't visible
  oabCheckScrollLock();
  const candidates = document.querySelectorAll('div, section, aside, iframe');
  for (const el of candidates) {
    if (oabIsEligibleCandidate(el)) {
      oabEvaluateCandidate(el);
    }
  }
}

function oabScheduleRescans() {
  oabClearRescanTimers();
  for (const delayMs of OAB_RESCAN_DELAYS_MS) {
    oabRescanTimers.push(setTimeout(oabShallowRescan, delayMs));
  }
}

function oabClearRescanTimers() {
  for (const t of oabRescanTimers) clearTimeout(t);
  oabRescanTimers = [];
}

document.addEventListener('visibilitychange', () => {
  if (!oabEnabledForPage) return;
  if (document.hidden) {
    oabClearRescanTimers();
  } else {
    oabScheduleRescans();
  }
});

// --- Restore message from popup --------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'OAB_RESTORE_HIDDEN') {
    oabRestoreAll();
  }
});

// --- Init --------------------------------------------------------------------

function oabStart() {
  oabEnabledForPage = true;
  oabPageLoadTime = Date.now();
  oabWaitForBodyThenAttach();
  oabScheduleRescans();
}

function oabStop() {
  oabEnabledForPage = false;
  if (oabObserver) {
    oabObserver.disconnect();
    oabObserver = null;
  }
  oabClearRescanTimers();
  if (oabDebounceTimer) clearTimeout(oabDebounceTimer);
  oabPending.clear();
}

function oabInit() {
  chrome.storage.local.get(['enabled', 'siteWhitelist'], (result) => {
    const enabled = result.enabled !== false;
    const whitelisted = oabIsWhitelisted(result.siteWhitelist);
    if (enabled && !whitelisted) {
      oabStart();
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!('enabled' in changes) && !('siteWhitelist' in changes)) return;
  chrome.storage.local.get(['enabled', 'siteWhitelist'], (result) => {
    const enabled = result.enabled !== false;
    const whitelisted = oabIsWhitelisted(result.siteWhitelist);
    if (enabled && !whitelisted) {
      if (!oabEnabledForPage) oabStart();
    } else {
      oabStop();
    }
  });
});

oabInit();
