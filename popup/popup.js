const enabledToggle = document.getElementById('oab-enabled-toggle');
const siteToggle = document.getElementById('oab-site-toggle');
const hostnameEl = document.getElementById('oab-hostname');
const statsCountEl = document.getElementById('oab-stats-count');
const restoreBtn = document.getElementById('oab-restore-btn');
const statusLine = document.getElementById('oab-status-line');

const reportToggleBtn = document.getElementById('oab-report-toggle');
const reportForm = document.getElementById('oab-report-form');
const reportCancelBtn = document.getElementById('oab-report-cancel');
const reportSubmitBtn = document.getElementById('oab-report-submit');
const reportStatus = document.getElementById('oab-report-status');
const reportHappened = document.getElementById('oab-report-happened');
const reportExpected = document.getElementById('oab-report-expected');

const ISSUE_PROXY_URL = 'https://adveil-issue-proxy.achiekanayake2.workers.dev/';

let activeTab = null;
let activeHostname = null;
let pollTimer = null;

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname || null;
  } catch (err) {
    return null;
  }
}

function isSupportedUrl(url) {
  return !!url && /^https?:\/\//.test(url);
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function setControlsDisabled(disabled) {
  siteToggle.disabled = disabled;
  restoreBtn.disabled = disabled;
}

function refreshStats() {
  if (!activeTab) return;
  chrome.runtime.sendMessage({ type: 'OAB_GET_TAB_STATS', tabId: activeTab.id }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    statsCountEl.textContent = String(response.total || 0);
  });
}

function refreshWhitelistState() {
  chrome.storage.local.get(['siteWhitelist'], (result) => {
    const list = Array.isArray(result.siteWhitelist) ? result.siteWhitelist : [];
    siteToggle.checked = activeHostname ? list.includes(activeHostname) : false;
  });
}

function refreshEnabledState() {
  chrome.storage.local.get(['enabled'], (result) => {
    enabledToggle.checked = result.enabled !== false;
  });
}

function updateSiteWhitelist(hostname, whitelisted) {
  chrome.storage.local.get(['siteWhitelist'], (result) => {
    const list = Array.isArray(result.siteWhitelist) ? result.siteWhitelist.slice() : [];
    const idx = list.indexOf(hostname);
    if (whitelisted && idx === -1) {
      list.push(hostname);
    } else if (!whitelisted && idx !== -1) {
      list.splice(idx, 1);
    }
    chrome.storage.local.set({ siteWhitelist: list });
  });
}

enabledToggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabledToggle.checked });
});

siteToggle.addEventListener('change', () => {
  if (!activeHostname) return;
  updateSiteWhitelist(activeHostname, siteToggle.checked);
});

function detectBrowserLabel() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  return 'Unknown';
}

// Random, non-identifying per-install ID for the backend's rate limit.
// Generated once, stored locally, sent only to the issue-proxy.
async function getOrCreateClientId() {
  const result = await new Promise((resolve) => chrome.storage.local.get(['reportClientId'], resolve));
  if (result.reportClientId) return result.reportClientId;
  const id = crypto.randomUUID();
  chrome.storage.local.set({ reportClientId: id });
  return id;
}

function setReportStatus(text, kind) {
  reportStatus.textContent = text;
  reportStatus.className = 'oab-report-status' + (kind ? ` oab-status-${kind}` : '');
}

function resetReportForm() {
  reportHappened.value = '';
  reportExpected.value = '';
  setReportStatus('', null);
}

reportToggleBtn.addEventListener('click', () => {
  const opening = reportForm.hidden;
  reportForm.hidden = !opening;
  reportToggleBtn.hidden = opening;
  if (opening) reportHappened.focus();
});

reportCancelBtn.addEventListener('click', () => {
  reportForm.hidden = true;
  reportToggleBtn.hidden = false;
  resetReportForm();
});

reportForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!reportHappened.value.trim()) {
    setReportStatus('Please describe what happened.', 'error');
    return;
  }
  if (!ISSUE_PROXY_URL) {
    setReportStatus('Report submission isn’t configured yet.', 'error');
    return;
  }

  const version = chrome.runtime.getManifest().version;
  const siteUrl = activeTab && isSupportedUrl(activeTab.url) ? activeTab.url : 'N/A';
  const title = activeHostname ? `Bug report: ${activeHostname}` : 'Bug report';

  const body = [
    `**Site URL**: ${siteUrl}`,
    `**Browser**: ${detectBrowserLabel()}`,
    `**Extension version**: ${version}`,
    '',
    '**What happened**:',
    reportHappened.value.trim(),
    '',
    '**What you expected**:',
    reportExpected.value.trim() || '(not provided)'
  ].join('\n');

  reportSubmitBtn.disabled = true;
  setReportStatus('Submitting…', null);

  try {
    const clientId = await getOrCreateClientId();
    const response = await fetch(ISSUE_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, clientId })
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(message || `Request failed (${response.status})`);
    }

    setReportStatus('Thanks - issue submitted.', 'success');
    setTimeout(() => {
      reportForm.hidden = true;
      reportToggleBtn.hidden = false;
      resetReportForm();
    }, 2000);
  } catch (err) {
    setReportStatus(`Couldn’t submit: ${err.message}`, 'error');
  } finally {
    reportSubmitBtn.disabled = false;
  }
});

restoreBtn.addEventListener('click', () => {
  if (!activeTab) return;
  chrome.tabs.sendMessage(activeTab.id, { type: 'OAB_RESTORE_HIDDEN' }, () => {
    // Swallow "no receiving end" errors - e.g. on pages where content
    // scripts don't run. Nothing useful to surface to the user here.
    void chrome.runtime.lastError;
    statusLine.textContent = 'Restored (this page only).';
    setTimeout(() => { statusLine.textContent = ''; }, 2000);
  });
});

async function init() {
  activeTab = await getActiveTab();
  const url = activeTab ? activeTab.url : null;

  if (!isSupportedUrl(url)) {
    hostnameEl.textContent = 'this page';
    statusLine.textContent = 'Not active on this page.';
    setControlsDisabled(true);
    refreshEnabledState();
    return;
  }

  activeHostname = getHostnameFromUrl(url);
  hostnameEl.textContent = activeHostname || 'this site';

  refreshEnabledState();
  refreshWhitelistState();
  refreshStats();

  // Simple 1s poll while the popup is open - adequate at this scale, see
  // plan.md "Messaging & badge" for why a push-based scheme isn't needed.
  pollTimer = setInterval(refreshStats, 1000);
}

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if ('enabled' in changes) refreshEnabledState();
  if ('siteWhitelist' in changes) refreshWhitelistState();
});

init();
