/* global chrome */

const RULE_ID_BASE = 1000;
const NATIVE_HOST = "com.tollgate.host";

const DEFAULT_CONFIG = {
  markdownPath: "",
  cooldownMinutes: 30,
  unlockMode: "all",
  unlockSection: "",
};

const DEFAULT_STREAK = { current: 0, longest: 0, lastDate: null };

const LOCAL_BACKUPS_KEY = "localBackups";
const MAX_LOCAL_BACKUPS = 5;

const SYNC_META_KEY = "tollgateSyncMeta";
const SYNC_CHUNK_PREFIX = "tollgateSyncChunk";
const SYNC_CHUNK_SIZE = 7000;

// ── Initialization ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await ensureLocalDefaults();
  await syncBlockingRules();
  connectNativeHost();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureLocalDefaults();
  await syncBlockingRules();
  connectNativeHost();
});

async function ensureLocalDefaults() {
  const data = await chrome.storage.local.get(null);
  const updates = {};

  if (!Array.isArray(data.blockedSites)) updates.blockedSites = [];
  if (!Array.isArray(data.tasks)) updates.tasks = [];
  if (!Array.isArray(data.timeLog)) updates.timeLog = [];
  if (!data.unlocks || typeof data.unlocks !== "object") updates.unlocks = {};

  const nextConfig = normalizeConfig(data.config || {});
  if (!data.config || !isSameConfig(data.config, nextConfig)) {
    updates.config = nextConfig;
  }

  const currentStreak = data.streak || {};
  if (
    typeof currentStreak.current !== "number" ||
    typeof currentStreak.longest !== "number" ||
    !("lastDate" in currentStreak)
  ) {
    updates.streak = { ...DEFAULT_STREAK, ...currentStreak };
  }

  if (!Array.isArray(data[LOCAL_BACKUPS_KEY])) {
    updates[LOCAL_BACKUPS_KEY] = [];
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function normalizeConfig(config) {
  const base = config && typeof config === "object" ? config : {};

  return {
    markdownPath:
      typeof base.markdownPath === "string"
        ? base.markdownPath
        : DEFAULT_CONFIG.markdownPath,
    cooldownMinutes:
      Number.isFinite(base.cooldownMinutes) && base.cooldownMinutes > 0
        ? Math.round(base.cooldownMinutes)
        : DEFAULT_CONFIG.cooldownMinutes,
    unlockMode: base.unlockMode === "section" ? "section" : "all",
    unlockSection:
      typeof base.unlockSection === "string"
        ? base.unlockSection
        : DEFAULT_CONFIG.unlockSection,
  };
}

function isSameConfig(a, b) {
  return (
    a.markdownPath === b.markdownPath &&
    a.cooldownMinutes === b.cooldownMinutes &&
    a.unlockMode === b.unlockMode &&
    a.unlockSection === b.unlockSection
  );
}

function isUnlockRequirementMet(tasks, config) {
  const list = Array.isArray(tasks) ? tasks : [];
  const cfg = normalizeConfig(config || {});

  if (cfg.unlockMode === "section") {
    const section = (cfg.unlockSection || "").trim();
    if (!section) return false;

    const scoped = list.filter((task) => (task.section || "Tasks") === section);
    return scoped.length > 0 && scoped.every((task) => task.completed);
  }

  return list.length > 0 && list.every((task) => task.completed);
}

// ── Blocking rules ──────────────────────────────────────────────────

async function syncBlockingRules() {
  const { blockedSites = [], unlocks = {} } = await chrome.storage.local.get([
    "blockedSites",
    "unlocks",
  ]);

  // Remove all existing dynamic rules first
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map((rule) => rule.id);

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
          extensionPath: "/blocked.html?site=" + encodeURIComponent(site),
        },
      },
      condition: {
        requestDomains: [site],
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
  const {
    blockedSites = [],
    config,
    unlocks = {},
    timeLog = [],
    tasks = [],
  } = await chrome.storage.local.get([
    "blockedSites",
    "config",
    "unlocks",
    "timeLog",
    "tasks",
  ]);

  if (!isUnlockRequirementMet(tasks, config)) {
    return null;
  }

  const cooldown = (normalizeConfig(config).cooldownMinutes || 30);
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
    .find((entry) => entry.site === site && !entry.lockedAt);
  if (openEntry) {
    openEntry.lockedAt = new Date().toISOString();
  }

  await chrome.storage.local.set({ unlocks, timeLog });
  await syncBlockingRules();

  // Redirect any open tabs on this site to the block page
  const blockedUrl = chrome.runtime.getURL(
    "/blocked.html?site=" + encodeURIComponent(site)
  );
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url) {
      try {
        const url = new URL(tab.url);
        if (url.hostname === site || url.hostname.endsWith("." + site)) {
          chrome.tabs.update(tab.id, { url: blockedUrl });
        }
      } catch {
        // ignore invalid URLs
      }
    }
  }
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
  const {
    tasks = [],
    config,
    streak = { current: 0, longest: 0, lastDate: null },
  } = await chrome.storage.local.get(["tasks", "config", "streak"]);

  if (!isUnlockRequirementMet(tasks, config)) return;

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

// ── Backups & Sync ──────────────────────────────────────────────────

async function buildLocalBackupSnapshot() {
  const state = await chrome.storage.local.get([
    "blockedSites",
    "tasks",
    "config",
    "streak",
    "timeLog",
    "unlocks",
  ]);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    blockedSites: Array.isArray(state.blockedSites) ? state.blockedSites : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    config: normalizeConfig(state.config || {}),
    streak: state.streak || { ...DEFAULT_STREAK },
    timeLog: Array.isArray(state.timeLog) ? state.timeLog : [],
    unlocks: state.unlocks && typeof state.unlocks === "object" ? state.unlocks : {},
  };
}

async function buildSyncSnapshot() {
  const state = await chrome.storage.local.get([
    "blockedSites",
    "tasks",
    "config",
    "streak",
  ]);

  const cfg = normalizeConfig(state.config || {});

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    blockedSites: Array.isArray(state.blockedSites) ? state.blockedSites : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    config: {
      cooldownMinutes: cfg.cooldownMinutes,
      unlockMode: cfg.unlockMode,
      unlockSection: cfg.unlockSection,
    },
    streak: state.streak || { ...DEFAULT_STREAK },
  };
}

function chunkString(input, size) {
  const chunks = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

async function writeSyncSnapshot(snapshot) {
  const serialized = JSON.stringify(snapshot);
  const chunks = chunkString(serialized, SYNC_CHUNK_SIZE);

  if (chunks.length === 0) {
    throw new Error("Empty sync snapshot");
  }

  const existing = await chrome.storage.sync.get(SYNC_META_KEY);
  const oldMeta = existing[SYNC_META_KEY];

  const payload = {
    [SYNC_META_KEY]: {
      version: 1,
      updatedAt: snapshot.createdAt,
      chunks: chunks.length,
    },
  };

  for (let i = 0; i < chunks.length; i++) {
    payload[`${SYNC_CHUNK_PREFIX}${i}`] = chunks[i];
  }

  await chrome.storage.sync.set(payload);

  if (oldMeta && Number.isInteger(oldMeta.chunks) && oldMeta.chunks > chunks.length) {
    const removeKeys = [];
    for (let i = chunks.length; i < oldMeta.chunks; i++) {
      removeKeys.push(`${SYNC_CHUNK_PREFIX}${i}`);
    }
    if (removeKeys.length > 0) {
      await chrome.storage.sync.remove(removeKeys);
    }
  }

  return {
    updatedAt: snapshot.createdAt,
    chunks: chunks.length,
    bytes: serialized.length,
  };
}

async function readSyncSnapshot() {
  const metaResult = await chrome.storage.sync.get(SYNC_META_KEY);
  const meta = metaResult[SYNC_META_KEY];

  if (!meta || !Number.isInteger(meta.chunks) || meta.chunks <= 0) {
    return null;
  }

  const keys = [];
  for (let i = 0; i < meta.chunks; i++) {
    keys.push(`${SYNC_CHUNK_PREFIX}${i}`);
  }

  const chunksResult = await chrome.storage.sync.get(keys);
  let serialized = "";
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = chunksResult[`${SYNC_CHUNK_PREFIX}${i}`];
    if (typeof chunk !== "string") {
      throw new Error("Sync snapshot is incomplete");
    }
    serialized += chunk;
  }

  return JSON.parse(serialized);
}

async function saveLocalBackup() {
  const snapshot = await buildLocalBackupSnapshot();
  const data = await chrome.storage.local.get(LOCAL_BACKUPS_KEY);
  const existing = Array.isArray(data[LOCAL_BACKUPS_KEY])
    ? data[LOCAL_BACKUPS_KEY]
    : [];

  const backupEntry = {
    id: crypto.randomUUID(),
    createdAt: snapshot.createdAt,
    snapshot,
  };

  const next = [backupEntry, ...existing].slice(0, MAX_LOCAL_BACKUPS);
  await chrome.storage.local.set({ [LOCAL_BACKUPS_KEY]: next });

  return {
    id: backupEntry.id,
    createdAt: backupEntry.createdAt,
    count: next.length,
  };
}

async function applySnapshot(snapshot, options = {}) {
  const fromSync = Boolean(options.fromSync);
  const current = await chrome.storage.local.get(["config"]);

  const incomingConfig = normalizeConfig(snapshot.config || {});
  const currentConfig = normalizeConfig(current.config || {});
  if (fromSync) {
    // markdownPath is device-specific, keep the local value.
    incomingConfig.markdownPath = currentConfig.markdownPath;
  }

  const nextState = {
    blockedSites: Array.isArray(snapshot.blockedSites) ? snapshot.blockedSites : [],
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
    config: incomingConfig,
    streak: snapshot.streak || { ...DEFAULT_STREAK },
    timeLog: Array.isArray(snapshot.timeLog) ? snapshot.timeLog : [],
    unlocks: snapshot.unlocks && typeof snapshot.unlocks === "object" ? snapshot.unlocks : {},
  };

  await chrome.storage.local.set(nextState);
  await syncBlockingRules();

  sendToNativeHost({ type: "tasks", tasks: nextState.tasks });

  return {
    tasks: nextState.tasks.length,
    blockedSites: nextState.blockedSites.length,
  };
}

async function restoreLatestLocalBackup() {
  const data = await chrome.storage.local.get(LOCAL_BACKUPS_KEY);
  const backups = Array.isArray(data[LOCAL_BACKUPS_KEY])
    ? data[LOCAL_BACKUPS_KEY]
    : [];

  if (backups.length === 0) return null;

  const latest = backups[0];
  await applySnapshot(latest.snapshot, { fromSync: false });

  return {
    id: latest.id,
    createdAt: latest.createdAt,
  };
}

async function syncNow() {
  const snapshot = await buildSyncSnapshot();
  return writeSyncSnapshot(snapshot);
}

async function restoreFromSync() {
  const snapshot = await readSyncSnapshot();
  if (!snapshot) return null;

  await saveLocalBackup(); // safety checkpoint before cross-device restore
  await applySnapshot(snapshot, { fromSync: true });

  return {
    createdAt: snapshot.createdAt || null,
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0,
  };
}

async function getBackupStatus() {
  const localData = await chrome.storage.local.get(LOCAL_BACKUPS_KEY);
  const backups = Array.isArray(localData[LOCAL_BACKUPS_KEY])
    ? localData[LOCAL_BACKUPS_KEY]
    : [];

  const syncData = await chrome.storage.sync.get(SYNC_META_KEY);
  const syncMeta = syncData[SYNC_META_KEY] || null;

  return {
    localBackups: backups.length,
    latestLocalBackupAt: backups[0]?.createdAt || null,
    latestSyncAt: syncMeta?.updatedAt || null,
  };
}

// ── Storage change listener ─────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.blockedSites || changes.unlocks) {
    syncBlockingRules();
  }

  if (changes.blockedSites || changes.tasks || changes.config || changes.streak) {
    syncNow().catch(() => {
      // Ignore sync write errors during background auto-sync.
    });
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
      } else if (msg.type === "config") {
        const { config } = await chrome.storage.local.get("config");
        const nextConfig = normalizeConfig({ ...config, ...msg.config });
        await chrome.storage.local.set({ config: nextConfig });
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
      if (!nativePort) connectNativeHost();
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
      const site = msg.site
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
      if (!blockedSites.includes(site)) {
        blockedSites.push(site);
        await chrome.storage.local.set({ blockedSites });
      }
      return { ok: true, blockedSites };
    }

    case "removeSite": {
      const data = await chrome.storage.local.get("blockedSites");
      const sites = (data.blockedSites || []).filter((site) => site !== msg.site);
      await chrome.storage.local.set({ blockedSites: sites });
      return { ok: true, blockedSites: sites };
    }

    case "unlock": {
      const unlock = await unlockSite(msg.site);
      if (!unlock) {
        return { ok: false, error: "Unlock requirement not completed" };
      }
      return { ok: true, unlock };
    }

    case "relock": {
      await chrome.alarms.clear(`relock-${msg.site}`);
      await relockSite(msg.site);
      return { ok: true };
    }

    case "updateConfig": {
      const { config } = await chrome.storage.local.get("config");
      const nextConfig = normalizeConfig({ ...config, ...msg.config });
      await chrome.storage.local.set({ config: nextConfig });
      return { ok: true, config: nextConfig };
    }

    case "syncNative": {
      sendToNativeHost({ type: "read" });
      return { ok: true };
    }

    case "backupStatus": {
      const status = await getBackupStatus();
      return { ok: true, status };
    }

    case "backupCreate": {
      const backup = await saveLocalBackup();
      return { ok: true, backup };
    }

    case "backupRestore": {
      const restored = await restoreLatestLocalBackup();
      if (!restored) {
        return { ok: false, error: "No local backup found" };
      }
      return { ok: true, restored };
    }

    case "syncNow": {
      try {
        const result = await syncNow();
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error.message || "Sync failed" };
      }
    }

    case "syncRestore": {
      try {
        const restored = await restoreFromSync();
        if (!restored) {
          return { ok: false, error: "No sync snapshot found" };
        }
        return { ok: true, restored };
      } catch (error) {
        return { ok: false, error: error.message || "Restore from sync failed" };
      }
    }

    default:
      return { error: "unknown message type" };
  }
}
