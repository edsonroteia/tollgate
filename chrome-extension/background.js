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
  await recreateRelockAlarms();
  connectNativeHost();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureLocalDefaults();
  await syncBlockingRules();
  await recreateRelockAlarms();
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

  if (!Array.isArray(data.siteGroups)) updates.siteGroups = [];
  if (!data.siteSettings || typeof data.siteSettings !== "object") updates.siteSettings = {};

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

// ── Group & Cost helpers ────────────────────────────────────────────

function resolveGroupForSite(site, siteGroups) {
  if (!Array.isArray(siteGroups)) return null;
  return siteGroups.find((g) => g.sites.includes(site)) || null;
}

function getEffectiveCost(site, siteGroups, siteSettings) {
  const group = resolveGroupForSite(site, siteGroups);
  if (group && group.cost >= 1) return group.cost;
  const settings = siteSettings && siteSettings[site];
  if (settings && settings.cost >= 1) return settings.cost;
  return null;
}

function isCostRequirementMet(tasks, config, cost, baseline) {
  if (cost === null || cost === undefined || cost <= 0) {
    return isUnlockRequirementMet(tasks, config);
  }
  const list = Array.isArray(tasks) ? tasks : [];
  const done = list.filter((t) => t.completed).length;
  const effective = done - (baseline || 0);
  return effective >= cost;
}

function getCostBaseline(site, siteGroups, siteSettings) {
  const group = resolveGroupForSite(site, siteGroups);
  if (group && typeof group.costBaseline === "number") return group.costBaseline;
  const settings = siteSettings && siteSettings[site];
  if (settings && typeof settings.costBaseline === "number") return settings.costBaseline;
  return 0;
}

// ── Blocking rules ──────────────────────────────────────────────────

let _syncQueue = Promise.resolve();

function syncBlockingRules() {
  _syncQueue = _syncQueue.then(_syncBlockingRulesImpl, _syncBlockingRulesImpl);
  return _syncQueue;
}

async function _syncBlockingRulesImpl() {
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
        urlFilter: "||" + site + "^",
        resourceTypes: ["main_frame"],
      },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules,
  });
}

// ── Unlock / Re-lock / Pause ────────────────────────────────────────

const PAUSE_MIN_JUSTIFICATION = 120;

async function unlockSite(site) {
  const {
    blockedSites = [],
    config,
    unlocks = {},
    timeLog = [],
    tasks = [],
    siteGroups = [],
    siteSettings = {},
  } = await chrome.storage.local.get([
    "blockedSites",
    "config",
    "unlocks",
    "timeLog",
    "tasks",
    "siteGroups",
    "siteSettings",
  ]);

  const cost = getEffectiveCost(site, siteGroups, siteSettings);
  const baseline = getCostBaseline(site, siteGroups, siteSettings);
  if (!isCostRequirementMet(tasks, config, cost, baseline)) {
    return null;
  }

  const cooldown = (normalizeConfig(config).cooldownMinutes || 30);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cooldown * 60000).toISOString();

  const group = resolveGroupForSite(site, siteGroups);
  const sitesToUnlock = group ? group.sites : [site];
  const removeRuleIds = [];

  for (const s of sitesToUnlock) {
    unlocks[s] = { unlockedAt: now.toISOString(), expiresAt };
    const idx = blockedSites.indexOf(s);
    if (idx !== -1) removeRuleIds.push(RULE_ID_BASE + idx);
  }

  // Only log the site the user actually visited, not all group members
  timeLog.push({ site, unlockedAt: now.toISOString(), lockedAt: null });

  if (group) {
    unlocks[`group:${group.id}`] = { unlockedAt: now.toISOString(), expiresAt };
  }

  // Save cost baseline so next cycle requires N *more* completed tasks
  if (cost !== null && cost >= 1) {
    const completedNow = (Array.isArray(tasks) ? tasks : []).filter((t) => t.completed).length;
    if (group) {
      group.costBaseline = completedNow;
      // siteGroups is already a reference to the fetched array
    } else {
      if (!siteSettings[site]) siteSettings[site] = {};
      siteSettings[site].costBaseline = completedNow;
    }
  }

  await chrome.storage.local.set({ unlocks, timeLog, siteGroups, siteSettings });

  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }

  // Set alarm — one per group or per site
  const alarmName = group ? `relock-group:${group.id}` : `relock-${site}`;
  chrome.alarms.create(alarmName, { delayInMinutes: cooldown });

  await updateStreak();

  return unlocks[site];
}

async function pauseSite(site, durationMinutes, justification) {
  if (typeof justification !== "string" || justification.trim().length < PAUSE_MIN_JUSTIFICATION) {
    return null;
  }

  const duration = [5, 15, 30].includes(durationMinutes) ? durationMinutes : 5;
  const { blockedSites = [], unlocks = {}, timeLog = [], siteGroups = [] } =
    await chrome.storage.local.get(["blockedSites", "unlocks", "timeLog", "siteGroups"]);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + duration * 60000).toISOString();

  const group = resolveGroupForSite(site, siteGroups);
  const sitesToPause = group ? group.sites : [site];
  const removeRuleIds = [];

  for (const s of sitesToPause) {
    unlocks[s] = { unlockedAt: now.toISOString(), expiresAt };
    const idx = blockedSites.indexOf(s);
    if (idx !== -1) removeRuleIds.push(RULE_ID_BASE + idx);
  }

  // Only log the site the user actually visited
  timeLog.push({
    site,
    unlockedAt: now.toISOString(),
    lockedAt: null,
    paused: true,
    justification: justification.trim(),
  });

  if (group) {
    unlocks[`group:${group.id}`] = { unlockedAt: now.toISOString(), expiresAt };
  }

  await chrome.storage.local.set({ unlocks, timeLog });

  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }

  const alarmName = group ? `relock-group:${group.id}` : `relock-${site}`;
  chrome.alarms.create(alarmName, { delayInMinutes: duration });

  return unlocks[site];
}

async function relockSite(site) {
  const { unlocks = {}, timeLog = [], siteGroups = [], siteSettings = {} } =
    await chrome.storage.local.get(["unlocks", "timeLog", "siteGroups", "siteSettings"]);

  const now = new Date().toISOString();
  let sitesToRelock;

  if (site.startsWith("group:")) {
    const groupId = site.slice("group:".length);
    const group = siteGroups.find((g) => g.id === groupId);
    sitesToRelock = group ? group.sites : [];
    delete unlocks[site];
    if (group) group.lastLockedAt = now;
  } else {
    const group = resolveGroupForSite(site, siteGroups);
    if (group) {
      sitesToRelock = group.sites;
      delete unlocks[`group:${group.id}`];
      group.lastLockedAt = now;
    } else {
      sitesToRelock = [site];
    }
  }

  for (const s of sitesToRelock) {
    delete unlocks[s];
    const openEntry = timeLog
      .slice()
      .reverse()
      .find((entry) => entry.site === s && !entry.lockedAt);
    if (openEntry) openEntry.lockedAt = now;

    if (!siteSettings[s]) siteSettings[s] = {};
    siteSettings[s].lastLockedAt = now;
  }

  await chrome.storage.local.set({ unlocks, timeLog, siteGroups, siteSettings });
  await syncBlockingRules();

  // Redirect open tabs for all relocked sites
  const tabs = await chrome.tabs.query({});
  for (const s of sitesToRelock) {
    const blockedUrl = chrome.runtime.getURL(
      "/blocked.html?site=" + encodeURIComponent(s)
    );
    for (const tab of tabs) {
      if (tab.url) {
        try {
          const url = new URL(tab.url);
          if (url.hostname === s || url.hostname.endsWith("." + s)) {
            chrome.tabs.update(tab.id, { url: blockedUrl });
          }
        } catch {
          // ignore invalid URLs
        }
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

async function recreateRelockAlarms() {
  const { unlocks = {} } = await chrome.storage.local.get("unlocks");
  const now = Date.now();
  const handled = new Set();

  // Process group: keys and standalone domain keys
  for (const [key, unlock] of Object.entries(unlocks)) {
    // For per-site keys that belong to a group, the group: key alarm covers them
    if (!key.startsWith("group:") && handled.has(key)) continue;

    const expiresAt = new Date(unlock.expiresAt).getTime();
    if (expiresAt > now) {
      const remaining = Math.max((expiresAt - now) / 60000, 0.5);
      chrome.alarms.create(`relock-${key}`, { delayInMinutes: remaining });
      if (key.startsWith("group:")) {
        // Mark per-site keys so we skip creating duplicate alarms
        for (const [k, u] of Object.entries(unlocks)) {
          if (!k.startsWith("group:") && u.expiresAt === unlock.expiresAt) {
            handled.add(k);
          }
        }
      }
    } else {
      await relockSite(key);
    }
  }
}

// ── Navigation fallback (catches service-worker-cached pages) ───────

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.url.startsWith("chrome") || details.url.startsWith("about")) return;
  void guardNavigation(details);
});

async function guardNavigation(details) {
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return;
  }

  const { blockedSites = [], unlocks = {} } = await chrome.storage.local.get([
    "blockedSites",
    "unlocks",
  ]);

  const now = Date.now();
  const matchedSite = blockedSites.find(
    (site) => hostname === site || hostname.endsWith("." + site)
  );

  if (!matchedSite) return;

  const unlock = unlocks[matchedSite];
  if (unlock && new Date(unlock.expiresAt).getTime() > now) return;

  const blockedUrl = chrome.runtime.getURL(
    "/blocked.html?site=" + encodeURIComponent(matchedSite)
  );

  chrome.tabs.update(details.tabId, { url: blockedUrl });
}

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
    "siteGroups",
    "siteSettings",
  ]);

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    blockedSites: Array.isArray(state.blockedSites) ? state.blockedSites : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    config: normalizeConfig(state.config || {}),
    streak: state.streak || { ...DEFAULT_STREAK },
    timeLog: Array.isArray(state.timeLog) ? state.timeLog : [],
    unlocks: state.unlocks && typeof state.unlocks === "object" ? state.unlocks : {},
    siteGroups: Array.isArray(state.siteGroups) ? state.siteGroups : [],
    siteSettings: state.siteSettings && typeof state.siteSettings === "object" ? state.siteSettings : {},
  };
}

async function buildSyncSnapshot() {
  const state = await chrome.storage.local.get([
    "blockedSites",
    "tasks",
    "config",
    "streak",
    "siteGroups",
    "siteSettings",
  ]);

  const cfg = normalizeConfig(state.config || {});

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    blockedSites: Array.isArray(state.blockedSites) ? state.blockedSites : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    config: {
      cooldownMinutes: cfg.cooldownMinutes,
      unlockMode: cfg.unlockMode,
      unlockSection: cfg.unlockSection,
    },
    streak: state.streak || { ...DEFAULT_STREAK },
    siteGroups: Array.isArray(state.siteGroups) ? state.siteGroups : [],
    siteSettings: state.siteSettings && typeof state.siteSettings === "object" ? state.siteSettings : {},
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
    siteGroups: Array.isArray(snapshot.siteGroups) ? snapshot.siteGroups : [],
    siteSettings: snapshot.siteSettings && typeof snapshot.siteSettings === "object" ? snapshot.siteSettings : {},
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

  if (changes.blockedSites || changes.tasks || changes.config || changes.streak || changes.siteGroups || changes.siteSettings) {
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
      const { blockedSites = [], siteSettings = {} } = await chrome.storage.local.get([
        "blockedSites",
        "siteSettings",
      ]);
      const site = msg.site
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
      if (!blockedSites.includes(site)) {
        blockedSites.push(site);
        if (!siteSettings[site]) siteSettings[site] = {};
        siteSettings[site].lastLockedAt = new Date().toISOString();
        await chrome.storage.local.set({ blockedSites, siteSettings });
      }
      return { ok: true, blockedSites };
    }

    case "removeSite": {
      const data = await chrome.storage.local.get(["blockedSites", "siteGroups", "siteSettings"]);
      const sites = (data.blockedSites || []).filter((site) => site !== msg.site);
      const groups = (data.siteGroups || []).map((g) => ({
        ...g,
        sites: g.sites.filter((s) => s !== msg.site),
      })).filter((g) => g.sites.length > 0);
      const settings = data.siteSettings || {};
      delete settings[msg.site];
      await chrome.storage.local.set({ blockedSites: sites, siteGroups: groups, siteSettings: settings });
      return { ok: true, blockedSites: sites };
    }

    case "unlock": {
      const unlock = await unlockSite(msg.site);
      if (!unlock) {
        return { ok: false, error: "Unlock requirement not completed" };
      }
      return { ok: true, unlock };
    }

    case "pause": {
      const pause = await pauseSite(msg.site, msg.duration, msg.justification);
      if (!pause) {
        return { ok: false, error: "Justification must be at least 120 characters" };
      }
      return { ok: true, unlock: pause };
    }

    case "relock": {
      const { siteGroups: rGroups = [] } = await chrome.storage.local.get("siteGroups");
      const rGroup = resolveGroupForSite(msg.site, rGroups);
      if (rGroup) {
        await chrome.alarms.clear(`relock-group:${rGroup.id}`);
      }
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

    case "addGroup": {
      const { siteGroups = [], blockedSites = [] } = await chrome.storage.local.get([
        "siteGroups",
        "blockedSites",
      ]);
      const groupSites = (msg.sites || []).filter((s) => typeof s === "string");
      // Validate no site is already in another group
      for (const s of groupSites) {
        const existing = resolveGroupForSite(s, siteGroups);
        if (existing) {
          return { ok: false, error: `${s} is already in group "${existing.name}"` };
        }
      }
      const now = new Date().toISOString();
      const newGroup = {
        id: crypto.randomUUID(),
        name: (msg.name || "Untitled Group").trim(),
        sites: groupSites,
        cost: msg.cost >= 1 ? Math.round(msg.cost) : null,
        lastLockedAt: now,
      };
      siteGroups.push(newGroup);
      // Ensure member sites are in blockedSites
      let sitesChanged = false;
      for (const s of groupSites) {
        if (!blockedSites.includes(s)) {
          blockedSites.push(s);
          sitesChanged = true;
        }
      }
      const groupUpdate = { siteGroups };
      if (sitesChanged) groupUpdate.blockedSites = blockedSites;
      await chrome.storage.local.set(groupUpdate);
      return { ok: true, group: newGroup };
    }

    case "updateGroup": {
      const { siteGroups: uGroups = [] } = await chrome.storage.local.get("siteGroups");
      const group = uGroups.find((g) => g.id === msg.id);
      if (!group) return { ok: false, error: "Group not found" };
      const newSites = msg.sites || group.sites;
      // Validate no site in multiple groups
      for (const s of newSites) {
        const existing = resolveGroupForSite(s, uGroups);
        if (existing && existing.id !== msg.id) {
          return { ok: false, error: `${s} is already in group "${existing.name}"` };
        }
      }
      if (msg.name !== undefined) group.name = (msg.name || "").trim();
      if (msg.sites !== undefined) group.sites = newSites;
      if (msg.cost !== undefined) group.cost = msg.cost >= 1 ? Math.round(msg.cost) : null;
      await chrome.storage.local.set({ siteGroups: uGroups });
      return { ok: true, group };
    }

    case "removeGroup": {
      const { siteGroups: dGroups = [], unlocks: dUnlocks = {} } =
        await chrome.storage.local.get(["siteGroups", "unlocks"]);
      const idx = dGroups.findIndex((g) => g.id === msg.id);
      if (idx === -1) return { ok: false, error: "Group not found" };
      delete dUnlocks[`group:${msg.id}`];
      dGroups.splice(idx, 1);
      await chrome.storage.local.set({ siteGroups: dGroups, unlocks: dUnlocks });
      await chrome.alarms.clear(`relock-group:${msg.id}`);
      return { ok: true };
    }

    case "updateSiteSettings": {
      const { siteSettings: uSettings = {} } = await chrome.storage.local.get("siteSettings");
      if (!uSettings[msg.site]) uSettings[msg.site] = {};
      if (msg.cost !== undefined) {
        uSettings[msg.site].cost = msg.cost >= 1 ? Math.round(msg.cost) : null;
      }
      await chrome.storage.local.set({ siteSettings: uSettings });
      return { ok: true, siteSettings: uSettings };
    }

    default:
      return { error: "unknown message type" };
  }
}
