/**
 * Heuristic overlay-ad detection engine - the core, original mechanism of
 * this extension (see plan.md "Overlay heuristic engine").
 *
 * Scores DOM elements against multiple weighted signals (fixed/sticky
 * position, high z-index, viewport coverage, body scroll-lock correlation,
 * delayed appearance after load, ad-keyword hints, ad iframe presence) and
 * hides (never removes) anything clearing HIDE_THRESHOLD.
 *
 * Relies on OAB_MARKER_ATTR from content-scripts/cosmetic-filter.js, which
 * runs first in the same content-script world (see manifest.json content_scripts
 * order) - elements already hidden by the cosmetic CSS pass are tagged with
 * that attribute and are skipped here entirely, both to avoid redundant work
 * and to avoid double-counting the same element in two different stats
 * buckets (see plan.md "Small implementation-time checks").
 */

// Flip on manually during development to see the per-signal score breakdown
// for every evaluated candidate in the console. Keep off for shipped builds.
const OAB_DEBUG = false;

const OAB_HIDE_THRESHOLD = 6;

const OAB_MIN_CANDIDATE_SIZE = 50; // px, both width and height, pre-filter

// Deliberately does NOT include "paywall": confirmed via fixture testing
// that it's a real false-positive trigger (a legitimate subscription paywall
// scored high enough to get auto-hidden once "paywall" contributed a point).
// More importantly, hiding paywalls isn't ad-blocking - a paywall is
// legitimate content-gating UI, and auto-removing it edges into "paywall
// bypass" territory, a different feature this extension does not intend to
// provide. Do not re-add it without re-reading this comment.
const OAB_AD_KEYWORDS = [
  'ad', 'ads', 'advert', 'sponsor', 'sponsored', 'promo',
  'overlay', 'interstitial', 'popup', 'adblock', 'nag',
  'banner', 'bnr'
];

const OAB_AD_IFRAME_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'adnxs.com',
  'amazon-adsystem.com', 'criteo.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'taboola.com', 'outbrain.com',
  'adform.net', 'smartadserver.com', 'appnexus.com'
];

// Standard IAB ad-unit pixel dimensions [width, height]. These are SMALL in
// absolute pixels relative to any real viewport, which is exactly why a pure
// "% of viewport" coverage signal misses them (confirmed against a real
// site during manual testing - see plan.md changelog / verification notes:
// a 728x90 fixed-position banner overlapping a video player scored well
// under threshold using coverage alone, since 728x90 is only ~7% of a
// 1280x720 viewport despite being a textbook intrusive overlay ad unit).
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

// oabIsWhitelisted is intentionally NOT redefined here - it's declared once
// in content-scripts/cosmetic-filter.js, which manifest.json guarantees
// loads first into this same content-script global scope. Redeclaring it
// here would silently shadow that definition (harmless for this particular
// function since both bodies are identical, but see the naming note at the
// top of cosmetic-filter.js for why duplicate top-level identifiers across
// these two files are a real, previously-hit bug class - avoid adding more).

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

// Auto-generated hex IDs/hashes (very common - React/component-library
// unique-id suffixes, analytics IDs, etc.) can spuriously contain a short
// keyword as an isolated substring once digits are treated as separators -
// found via live testing: "surveyWindowWrap-40ea9b0799ad6c6bd5d8fe24139f..."
// tokenizes to include "ad" (from "...9ad6...") purely by digit-boundary
// coincidence, with nothing to do with advertising. Strip long hex runs
// before tokenizing so random hashes can't masquerade as keyword matches.
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

  const coverage = oabViewportCoverageRatio(el);
  if (coverage >= 0.6) signals.coverage = 4;
  else if (coverage >= 0.3) signals.coverage = 2;
  else if (coverage >= 0.15 && style.position === 'fixed') signals.coverage = 1;
  else signals.coverage = 0;
  score += signals.coverage;

  // Standard IAB ad-unit size, fixed/sticky positioned: a strong signal on
  // its own, independent of viewport coverage %, since these units are
  // deliberately small-in-pixels (see OAB_STANDARD_AD_SIZES comment above).
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

  if (OAB_DEBUG) {
    console.log('[overlay-ad-blocker]', JSON.stringify({
      score, signals, id: el.id, className: typeof el.className === 'string' ? el.className : null
    }));
  }

  return score;
}

// --- Hide / restore --------------------------------------------------------

function oabHideElement(el, score) {
  if (el.hasAttribute('data-oab-hidden-by')) return; // already handled

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
  if (el.hasAttribute('data-oab-hidden-by')) return false; // dedupe (incl. cosmetic-filter hits)
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return w >= OAB_MIN_CANDIDATE_SIZE && h >= OAB_MIN_CANDIDATE_SIZE;
}

function oabEvaluateCandidate(el) {
  if (!oabFirstSeenAt.has(el)) {
    oabFirstSeenAt.set(el, Date.now());
  }
  if (!oabIsEligibleCandidate(el)) return;
  const score = oabScoreElement(el);
  if (score >= OAB_HIDE_THRESHOLD) {
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
