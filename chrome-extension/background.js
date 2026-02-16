/* global chrome */

const RULE_ID_BASE = 1000;
const NATIVE_HOST = "com.tollgate.host";

// ── Initialization ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(null);
  if (!data.blockedSites) {
    await chrome.storage.local.set({
      blockedSites: [],
      tasks: [],
      config: { markdownPath: "", cooldownMinutes: 30 },
      streak: { current: 0, longest: 0, lastDate: null },
      timeLog: [],
      unlocks: {},
    });
  }
  await syncBlockingRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncBlockingRules();
});

// ── Blocking rules ──────────────────────────────────────────────────

function siteToRuleId(site, sites) {
  return RULE_ID_BASE + sites.indexOf(site);
}

async function syncBlockingRules() {
  const { blockedSites = [], unlocks = {} } = await chrome.storage.local.get([
    "blockedSites",
    "unlocks",
  ]);

  // Remove all existing dynamic rules first
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map((r) => r.id);

  // Build rules for sites that are not currently unlocked
  const now = Date.now();
  const addRules = [];

  for (let i = 0; i < blockedSites.length; i++) {
    const site = blockedSites[i];
    const unlock = unlocks[site];

    if (unlock && new Date(unlock.expiresAt).getTime() > now) {
      continue; // still unlocked
    }

    addRules.push({
      id: RULE_ID_BASE + i,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          extensionPath:
            "/blocked.html?site=" + encodeURIComponent(site),
        },
      },
      condition: {
        urlFilter: "||" + site,
        resourceTypes: ["main_frame"],
      },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules,
  });
}

// ── Unlock / Re-lock ────────────────────────────────────────────────

async function unlockSite(site) {
  const { blockedSites = [], config, unlocks = {}, timeLog = [] } =
    await chrome.storage.local.get([
      "blockedSites",
      "config",
      "unlocks",
      "timeLog",
    ]);

  const cooldown = (config && config.cooldownMinutes) || 30;
  const now = new Date();

  unlocks[site] = {
    unlockedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + cooldown * 60000).toISOString(),
  };

  timeLog.push({
    site,
    unlockedAt: now.toISOString(),
    lockedAt: null,
  });

  await chrome.storage.local.set({ unlocks, timeLog });

  // Remove the blocking rule for this site
  const idx = blockedSites.indexOf(site);
  if (idx !== -1) {
    const ruleId = RULE_ID_BASE + idx;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
    });
  }

  // Set alarm to re-lock
  chrome.alarms.create(`relock-${site}`, { delayInMinutes: cooldown });

  // Update streak
  await updateStreak();

  return unlocks[site];
}

async function relockSite(site) {
  const { unlocks = {}, timeLog = [] } = await chrome.storage.local.get([
    "unlocks",
    "timeLog",
  ]);

  delete unlocks[site];

  // Close the time log entry
  const openEntry = timeLog
    .slice()
    .reverse()
    .find((e) => e.site === site && !e.lockedAt);
  if (openEntry) {
    openEntry.lockedAt = new Date().toISOString();
  }

  await chrome.storage.local.set({ unlocks, timeLog });
  await syncBlockingRules();
}

// ── Alarms ──────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("relock-")) {
    const site = alarm.name.slice("relock-".length);
    await relockSite(site);
  }
});

// ── Streak tracking ─────────────────────────────────────────────────

async function updateStreak() {
  const { tasks = [], streak = { current: 0, longest: 0, lastDate: null } } =
    await chrome.storage.local.get(["tasks", "streak"]);

  const allDone = tasks.length > 0 && tasks.every((t) => t.completed);
  if (!allDone) return;

  const today = new Date().toISOString().slice(0, 10);
  if (streak.lastDate === today) return; // already counted today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (streak.lastDate === yesterday) {
    streak.current += 1;
  } else {
    streak.current = 1;
  }

  if (streak.current > streak.longest) {
    streak.longest = streak.current;
  }
  streak.lastDate = today;

  await chrome.storage.local.set({ streak });
}

// ── Storage change listener ─────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blockedSites) {
    syncBlockingRules();
  }
});

// ── Native messaging ────────────────────────────────────────────────

let nativePort = null;

function connectNativeHost() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);

    nativePort.onMessage.addListener(async (msg) => {
      if (msg.type === "tasks") {
        await chrome.storage.local.set({ tasks: msg.tasks });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
    });
  } catch {
    nativePort = null;
  }
}

function sendToNativeHost(msg) {
  if (!nativePort) {
    connectNativeHost();
  }
  if (nativePort) {
    try {
      nativePort.postMessage(msg);
    } catch {
      nativePort = null;
    }
  }
}

// ── Message handling (from popup & blocked page) ────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    case "getState": {
      const state = await chrome.storage.local.get(null);
      return state;
    }

    case "updateTasks": {
      await chrome.storage.local.set({ tasks: msg.tasks });
      sendToNativeHost({ type: "tasks", tasks: msg.tasks });
      return { ok: true };
    }

    case "addSite": {
      const { blockedSites = [] } = await chrome.storage.local.get("blockedSites");
      const site = msg.site.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      if (!blockedSites.includes(site)) {
        blockedSites.push(site);
        await chrome.storage.local.set({ blockedSites });
      }
      return { ok: true, blockedSites };
    }

    case "removeSite": {
      const data = await chrome.storage.local.get("blockedSites");
      const sites = (data.blockedSites || []).filter((s) => s !== msg.site);
      await chrome.storage.local.set({ blockedSites: sites });
      return { ok: true, blockedSites: sites };
    }

    case "unlock": {
      const unlock = await unlockSite(msg.site);
      return { ok: true, unlock };
    }

    case "updateConfig": {
      const { config } = await chrome.storage.local.get("config");
      Object.assign(config, msg.config);
      await chrome.storage.local.set({ config });
      return { ok: true };
    }

    case "syncNative": {
      sendToNativeHost({ type: "read" });
      return { ok: true };
    }

    default:
      return { error: "unknown message type" };
  }
}
