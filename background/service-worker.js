/**
 * Background service worker (Chrome) / event page (Firefox).
 *
 * Deliberately a single flat script - no ES `import`/`export` - so the same
 * file works whether the runtime treats it as a service worker (Chrome,
 * manifest key `service_worker`) or a classic background script (Firefox,
 * manifest key `scripts`). See manifest.json + plan.md "manifest.json".
 *
 * Responsibilities:
 *  - First-run + schema migration for chrome.storage.local
 *  - Per-tab block counters (overlay + cosmetic hides), mirrored to
 *    chrome.storage.session where available, with rehydration on startup
 *    so a service-worker restart doesn't show a stale/zero badge
 *  - Toolbar badge updates
 *  - Message handling from content scripts (counts) and the popup (reads)
 *
 * NOT handled here (see plan.md "Known MV3 limitation"): exact
 * declarativeNetRequest block counts. That production-accurate API isn't
 * available outside dev/unpacked mode, so the badge intentionally reflects
 * only overlay + cosmetic hides, which this script CAN observe reliably.
 */

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS = {
  enabled: true,
  siteWhitelist: [],
  stats: {
    totalOverlaysBlocked: 0,
    totalCosmeticBlocked: 0,
    installDate: null
  },
  schemaVersion: CURRENT_SCHEMA_VERSION
};

// Whether chrome.storage.session is usable in this browser/runtime. Firefox
// support for storage.session varies by version; feature-detect rather than
// assume. Per plan.md: if unavailable, per-tab counters are best-effort only
// and will reset on a service-worker restart - an accepted MVP gap.
const HAS_SESSION_STORAGE = !!(chrome.storage && chrome.storage.session);

// In-memory per-tab counters: tabId -> { overlay: number, cosmetic: number }
// This is the working copy the badge is always drawn from; storage.session
// (when available) is a durability mirror, not the primary source during a
// live worker lifetime.
let tabStats = new Map();
let rehydrated = false;

function sessionKeyFor(tabId) {
  return `tabstats_${tabId}`;
}

function emptyStats() {
  return { overlay: 0, cosmetic: 0 };
}

// --- Storage bootstrap / migration -----------------------------------------

function runMigrations(stored) {
  // Only one schema version exists today, but this check is real (not
  // decorative) so future schemaVersion bumps have a place to land instead
  // of being invented the first time they're needed.
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  settings.stats = Object.assign({}, DEFAULT_SETTINGS.stats, stored.stats);

  if (!settings.installDate && !settings.stats.installDate) {
    settings.stats.installDate = new Date().toISOString().slice(0, 10);
  }

  if (typeof settings.schemaVersion !== 'number' || settings.schemaVersion < CURRENT_SCHEMA_VERSION) {
    // Migration step(s) would run here, keyed off settings.schemaVersion,
    // e.g.: if (settings.schemaVersion < 2) { ...upgrade shape... }
    settings.schemaVersion = CURRENT_SCHEMA_VERSION;
  }

  return settings;
}

function ensureSettingsInitialized() {
  chrome.storage.local.get(null, (stored) => {
    const migrated = runMigrations(stored || {});
    chrome.storage.local.set(migrated);
  });
}

// --- Per-tab counter rehydration --------------------------------------------

function rehydrateFromSession() {
  return new Promise((resolve) => {
    if (!HAS_SESSION_STORAGE) {
      rehydrated = true;
      resolve();
      return;
    }
    chrome.storage.session.get(null, (items) => {
      for (const [key, value] of Object.entries(items || {})) {
        if (key.startsWith('tabstats_') && value) {
          const tabId = Number(key.slice('tabstats_'.length));
          if (!Number.isNaN(tabId)) {
            tabStats.set(tabId, {
              overlay: value.overlay || 0,
              cosmetic: value.cosmetic || 0
            });
          }
        }
      }
      rehydrated = true;
      resolve();
    });
  });
}

async function ensureRehydrated() {
  if (!rehydrated) {
    await rehydrateFromSession();
  }
}

function persistTabStats(tabId, stats) {
  if (!HAS_SESSION_STORAGE) return;
  chrome.storage.session.set({ [sessionKeyFor(tabId)]: stats });
}

function clearTabStats(tabId) {
  tabStats.delete(tabId);
  if (HAS_SESSION_STORAGE) {
    chrome.storage.session.remove(sessionKeyFor(tabId));
  }
}

// --- Badge -------------------------------------------------------------------

function updateBadge(tabId) {
  const stats = tabStats.get(tabId) || emptyStats();
  const total = stats.overlay + stats.cosmetic;
  const text = total > 0 ? String(Math.min(total, 999)) : '';
  chrome.action.setBadgeText({ tabId, text });
  if (total > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
  }
}

async function bumpTabStat(tabId, field, amount) {
  await ensureRehydrated();
  const stats = tabStats.get(tabId) || emptyStats();
  stats[field] += amount;
  tabStats.set(tabId, stats);
  persistTabStats(tabId, stats);
  updateBadge(tabId);
}

async function setTabCosmeticCount(tabId, absoluteCount) {
  await ensureRehydrated();
  const stats = tabStats.get(tabId) || emptyStats();
  stats.cosmetic = absoluteCount;
  tabStats.set(tabId, stats);
  persistTabStats(tabId, stats);
  updateBadge(tabId);
}

// --- Message handling ----------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case 'OAB_ELEMENT_BLOCKED': {
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') return undefined;
      const field = message.source === 'cosmetic-filter' ? 'cosmetic' : 'overlay';
      const amount = typeof message.count === 'number' ? message.count : 1;
      bumpTabStat(tabId, field, amount);
      return undefined;
    }

    case 'OAB_COSMETIC_COUNT_SYNC': {
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') return undefined;
      const count = typeof message.count === 'number' ? message.count : 0;
      setTabCosmeticCount(tabId, count);
      return undefined;
    }

    case 'OAB_GET_TAB_STATS': {
      const tabId = message.tabId;
      (async () => {
        await ensureRehydrated();
        const stats = tabStats.get(tabId) || emptyStats();
        sendResponse({
          type: 'OAB_TAB_STATS',
          tabId,
          overlayBlocked: stats.overlay,
          cosmeticBlocked: stats.cosmetic,
          total: stats.overlay + stats.cosmetic
        });
      })();
      return true; // keep the message channel open for the async sendResponse
    }

    default:
      return undefined;
  }
});

// --- Tab lifecycle: reset on navigation, cleanup on close -------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // A fresh top-level load - previous counts are stale.
    // (Known scope limit: SPA/pushState navigations do NOT fire this, so
    // counters persist across client-side route changes. See plan.md.)
    tabStats.set(tabId, emptyStats());
    persistTabStats(tabId, emptyStats());
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabStats(tabId);
});

// --- Startup / install ----------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  ensureSettingsInitialized();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSettingsInitialized();
  rehydrateFromSession();
});

// Also run on every worker (re)start, not just onStartup - Chrome can spin
// the service worker back up on a message without firing onStartup.
ensureSettingsInitialized();
rehydrateFromSession();
