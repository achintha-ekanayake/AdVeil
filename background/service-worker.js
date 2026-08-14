/**
 * Background service worker (Chrome) / event page (Firefox). Flat script,
 * no ES import/export, so it works as both. Handles storage migration,
 * per-tab badge counters (overlay + cosmetic hides only, not network - see
 * plan.md "Known MV3 limitation"), and messages from content scripts/popup.
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

// Feature-detect rather than assume (Firefox support varies by version).
// If unavailable, per-tab counters are best-effort and reset on restart.
const HAS_SESSION_STORAGE = !!(chrome.storage && chrome.storage.session);

// tabId -> { overlay, cosmetic }. The working copy the badge reads from;
// storage.session (if available) is a durability mirror, not the source.
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
  // Real check, not decorative, so future schemaVersion bumps land here.
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
    // Fresh top-level load - previous counts are stale. SPA/pushState
    // navigations don't fire this, so counters persist there (see plan.md).
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
