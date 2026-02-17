/* global chrome */

let state = {};
let backupStatus = {
  localBackups: 0,
  latestLocalBackupAt: null,
  latestSyncAt: null,
};
let unlockIntervals = [];
let abstinenceTimerInterval = null;
let statusMessage = "";
let editingGroupId = null;

// ── Init ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  state = await chrome.runtime.sendMessage({ type: "getState" });
  await refreshBackupStatus();
  render();

  // Add site
  const addBtn = document.getElementById("siteAddBtn");
  const input = document.getElementById("siteInput");

  addBtn.addEventListener("click", () => addSite(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addSite(input);
  });

  // Cooldown select
  document.getElementById("cooldownSelect").addEventListener("change", (event) => {
    void updateConfig({ cooldownMinutes: parseInt(event.target.value, 10) });
  });

  // Unlock mode / section
  document
    .getElementById("unlockModeSelect")
    .addEventListener("change", (event) => {
      void handleUnlockModeChange(event.target.value);
    });

  document
    .getElementById("unlockSectionSelect")
    .addEventListener("change", (event) => {
      void updateConfig({ unlockSection: event.target.value });
    });

  // Group actions
  document.getElementById("groupAddBtn").addEventListener("click", () => {
    openGroupEditor(null);
  });
  document.getElementById("groupSaveBtn").addEventListener("click", () => {
    void saveGroup();
  });
  document.getElementById("groupCancelBtn").addEventListener("click", () => {
    closeGroupEditor();
  });

  // Backup / sync actions
  document.getElementById("backupNowBtn").addEventListener("click", () => {
    void createBackup();
  });

  document.getElementById("restoreBackupBtn").addEventListener("click", () => {
    void restoreBackup();
  });

  document.getElementById("syncNowBtn").addEventListener("click", () => {
    void syncNow();
  });

  document.getElementById("restoreSyncBtn").addEventListener("click", () => {
    void restoreSync();
  });
});

// ── Data helpers ────────────────────────────────────────────────────

function getTaskSections() {
  const sections = [];
  const seen = new Set();

  for (const task of state.tasks || []) {
    const section = task.section || "Tasks";
    if (!seen.has(section)) {
      seen.add(section);
      sections.push(section);
    }
  }

  return sections;
}

function formatDateTime(value) {
  if (!value) return "never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function setStatus(text) {
  statusMessage = text;
  renderBackupStatus();
}

function formatDuration(ms) {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resolveGroupForSite(site, siteGroups) {
  if (!Array.isArray(siteGroups)) return null;
  return siteGroups.find((g) => g.sites.includes(site)) || null;
}

function getEffectiveCostForSite(site) {
  const siteGroups = state.siteGroups || [];
  const siteSettings = state.siteSettings || {};
  const group = resolveGroupForSite(site, siteGroups);
  if (group && group.cost >= 1) return group.cost;
  const settings = siteSettings[site];
  if (settings && settings.cost >= 1) return settings.cost;
  return null;
}

function getSiteLastLockedAt(site) {
  const siteGroups = state.siteGroups || [];
  const siteSettings = state.siteSettings || {};
  const group = resolveGroupForSite(site, siteGroups);
  if (group && group.lastLockedAt) return group.lastLockedAt;
  const settings = siteSettings[site];
  if (settings && settings.lastLockedAt) return settings.lastLockedAt;
  return null;
}

function isSiteUnlocked(site) {
  const unlock = (state.unlocks || {})[site];
  return unlock && new Date(unlock.expiresAt).getTime() > Date.now();
}

async function refreshState() {
  state = await chrome.runtime.sendMessage({ type: "getState" });
}

async function refreshBackupStatus() {
  const resp = await chrome.runtime.sendMessage({ type: "backupStatus" });
  if (resp.ok) {
    backupStatus = resp.status;
  }
}

async function updateConfig(configPatch) {
  const resp = await chrome.runtime.sendMessage({
    type: "updateConfig",
    config: configPatch,
  });

  if (resp.ok) {
    state.config = resp.config;
    renderConfig();
    setStatus("Settings updated");
  }
}

// ── Actions ─────────────────────────────────────────────────────────

async function addSite(input) {
  const val = input.value.trim();
  if (!val) return;

  const resp = await chrome.runtime.sendMessage({ type: "addSite", site: val });
  if (resp.ok) {
    state.blockedSites = resp.blockedSites;
    input.value = "";
    renderSites();
  }
}

async function handleUnlockModeChange(mode) {
  const sections = getTaskSections();
  const nextMode = mode === "section" ? "section" : "all";
  const currentSection = (state.config && state.config.unlockSection) || "";

  let nextSection = "";
  if (nextMode === "section") {
    nextSection = currentSection && sections.includes(currentSection)
      ? currentSection
      : sections[0] || "";
  }

  await updateConfig({ unlockMode: nextMode, unlockSection: nextSection });
}

async function createBackup() {
  const resp = await chrome.runtime.sendMessage({ type: "backupCreate" });
  if (resp.ok) {
    await refreshBackupStatus();
    renderBackupStatus();
    setStatus(`Backup saved at ${formatDateTime(resp.backup.createdAt)}`);
  } else {
    setStatus(resp.error || "Backup failed");
  }
}

async function restoreBackup() {
  const resp = await chrome.runtime.sendMessage({ type: "backupRestore" });
  if (resp.ok) {
    await refreshState();
    await refreshBackupStatus();
    render();
    setStatus(`Restored backup from ${formatDateTime(resp.restored.createdAt)}`);
  } else {
    setStatus(resp.error || "Restore failed");
  }
}

async function syncNow() {
  const resp = await chrome.runtime.sendMessage({ type: "syncNow" });
  if (resp.ok) {
    await refreshBackupStatus();
    renderBackupStatus();
    setStatus(`Synced at ${formatDateTime(resp.result.updatedAt)}`);
  } else {
    setStatus(resp.error || "Sync failed");
  }
}

async function restoreSync() {
  const resp = await chrome.runtime.sendMessage({ type: "syncRestore" });
  if (resp.ok) {
    await refreshState();
    await refreshBackupStatus();
    render();
    const when = resp.restored.createdAt
      ? formatDateTime(resp.restored.createdAt)
      : "latest snapshot";
    setStatus(`Restored from sync (${when})`);
  } else {
    setStatus(resp.error || "Sync restore failed");
  }
}

// ── Render ──────────────────────────────────────────────────────────

function render() {
  renderStats();
  renderSites();
  renderGroups();
  renderUnlocks();
  renderConfig();
  renderBackupStatus();
  startAbstinenceTimers();
}

function renderStats() {
  const streak = state.streak || { current: 0 };
  document.getElementById("streakValue").textContent = streak.current;

  const tasks = state.tasks || [];
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = tasks.filter(
    (task) => task.completed && task.completedAt && task.completedAt.startsWith(today)
  ).length;
  document.getElementById("tasksToday").textContent = doneToday;

  const cooldown = (state.config && state.config.cooldownMinutes) || 30;
  document.getElementById("cooldownStatus").textContent = cooldown + "m";
}

function renderSites() {
  const list = document.getElementById("siteList");
  list.innerHTML = "";

  for (const site of state.blockedSites || []) {
    const pill = document.createElement("span");
    pill.className = "site-pill";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = site;
    pill.appendChild(nameSpan);

    // Group badge
    const group = resolveGroupForSite(site, state.siteGroups || []);
    if (group) {
      const badge = document.createElement("span");
      badge.className = "site-badge site-badge--group";
      badge.textContent = group.name;
      pill.appendChild(badge);
    }

    // Cost badge
    const cost = getEffectiveCostForSite(site);
    if (cost !== null) {
      const badge = document.createElement("span");
      badge.className = "site-badge site-badge--cost";
      badge.textContent = cost + "t";
      badge.title = `Unlock cost: ${cost} tasks`;
      pill.appendChild(badge);
    }

    // Abstinence timer (when locked)
    if (!isSiteUnlocked(site)) {
      const lastLocked = getSiteLastLockedAt(site);
      if (lastLocked) {
        const timerSpan = document.createElement("span");
        timerSpan.className = "site-abstinence";
        timerSpan.dataset.since = lastLocked;
        pill.appendChild(timerSpan);
      }
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "site-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", async () => {
      const resp = await chrome.runtime.sendMessage({
        type: "removeSite",
        site,
      });
      if (resp.ok) {
        state.blockedSites = resp.blockedSites;
        // Also refresh siteGroups/siteSettings
        await refreshState();
        render();
      }
    });

    pill.appendChild(removeBtn);
    list.appendChild(pill);
  }
}

function renderUnlocks() {
  const unlocks = state.unlocks || {};
  const now = Date.now();
  const active = Object.entries(unlocks).filter(
    ([, unlock]) => new Date(unlock.expiresAt).getTime() > now
  );

  const section = document.getElementById("unlocksSection");
  const list = document.getElementById("unlockList");

  // Clear previous intervals
  for (const id of unlockIntervals) clearInterval(id);
  unlockIntervals = [];

  if (active.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = "";

  // Collapse group unlocks: track which sites are covered by a group: key
  const groupCoveredSites = new Set();
  const siteGroups = state.siteGroups || [];

  for (const [key] of active) {
    if (key.startsWith("group:")) {
      const groupId = key.slice("group:".length);
      const group = siteGroups.find((g) => g.id === groupId);
      if (group) {
        for (const s of group.sites) groupCoveredSites.add(s);
      }
    }
  }

  for (const [key, unlock] of active) {
    // Skip per-site keys that are covered by a group
    if (!key.startsWith("group:") && groupCoveredSites.has(key)) continue;

    const item = document.createElement("div");
    item.className = "unlock-item";

    const name = document.createElement("span");
    if (key.startsWith("group:")) {
      const groupId = key.slice("group:".length);
      const group = siteGroups.find((g) => g.id === groupId);
      name.textContent = group ? group.name : key;
    } else {
      name.textContent = key;
    }

    const timer = document.createElement("span");
    timer.className = "unlock-timer";

    const updateTimer = () => {
      const remaining = new Date(unlock.expiresAt) - Date.now();
      if (remaining <= 0) {
        timer.textContent = "locked";
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      timer.textContent = `${m}:${String(s).padStart(2, "0")}`;
    };

    updateTimer();
    const intervalId = setInterval(updateTimer, 1000);
    unlockIntervals.push(intervalId);

    const relockBtn = document.createElement("button");
    relockBtn.className = "relock-btn";
    relockBtn.textContent = "Reblock";
    relockBtn.addEventListener("click", async () => {
      if (key.startsWith("group:")) {
        const groupId = key.slice("group:".length);
        const group = siteGroups.find((g) => g.id === groupId);
        if (group && group.sites.length > 0) {
          await chrome.runtime.sendMessage({ type: "relock", site: group.sites[0] });
        }
      } else {
        await chrome.runtime.sendMessage({ type: "relock", site: key });
      }
      await refreshState();
      render();
    });

    item.appendChild(name);
    item.appendChild(timer);
    item.appendChild(relockBtn);
    list.appendChild(item);
  }
}

function renderGroups() {
  const list = document.getElementById("groupList");
  list.innerHTML = "";
  const groups = state.siteGroups || [];

  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "group-empty";
    empty.textContent = "No groups yet";
    list.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "group-card";

    const header = document.createElement("div");
    header.className = "group-card-header";

    const nameEl = document.createElement("span");
    nameEl.className = "group-name";
    nameEl.textContent = group.name;
    header.appendChild(nameEl);

    if (group.cost >= 1) {
      const costBadge = document.createElement("span");
      costBadge.className = "group-cost-badge";
      costBadge.textContent = group.cost + "t";
      costBadge.title = `Unlock cost: ${group.cost} tasks`;
      header.appendChild(costBadge);
    }

    const headerActions = document.createElement("div");
    headerActions.className = "group-header-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "group-edit-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openGroupEditor(group));
    headerActions.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "group-delete-btn";
    deleteBtn.textContent = "Del";
    deleteBtn.addEventListener("click", () => void removeGroup(group.id));
    headerActions.appendChild(deleteBtn);

    header.appendChild(headerActions);
    card.appendChild(header);

    // Site pills
    const sitesEl = document.createElement("div");
    sitesEl.className = "group-sites";
    for (const s of group.sites) {
      const pill = document.createElement("span");
      pill.className = "group-site-pill";
      pill.textContent = s;
      sitesEl.appendChild(pill);
    }
    card.appendChild(sitesEl);

    // Abstinence timer for group
    if (group.lastLockedAt) {
      const allUnlocked = group.sites.every((s) => isSiteUnlocked(s));
      if (!allUnlocked) {
        const timerEl = document.createElement("span");
        timerEl.className = "group-abstinence";
        timerEl.dataset.since = group.lastLockedAt;
        card.appendChild(timerEl);
      }
    }

    list.appendChild(card);
  }
}

function openGroupEditor(group) {
  editingGroupId = group ? group.id : null;
  const editor = document.getElementById("groupEditor");
  const nameInput = document.getElementById("groupNameInput");
  const costInput = document.getElementById("groupCostInput");
  const checkboxes = document.getElementById("groupSiteCheckboxes");

  nameInput.value = group ? group.name : "";
  costInput.value = group && group.cost >= 1 ? group.cost : "";

  // Build site checkboxes from blockedSites
  checkboxes.innerHTML = "";
  const groupSites = group ? new Set(group.sites) : new Set();

  for (const site of state.blockedSites || []) {
    // Skip sites that are in OTHER groups (unless editing this group)
    const existingGroup = resolveGroupForSite(site, state.siteGroups || []);
    if (existingGroup && existingGroup.id !== editingGroupId) continue;

    const label = document.createElement("label");
    label.className = "group-site-checkbox-label";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = site;
    cb.checked = groupSites.has(site);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + site));
    checkboxes.appendChild(label);
  }

  editor.hidden = false;
  document.getElementById("groupAddBtn").hidden = true;
}

function closeGroupEditor() {
  document.getElementById("groupEditor").hidden = true;
  document.getElementById("groupAddBtn").hidden = false;
  editingGroupId = null;
}

async function saveGroup() {
  const name = document.getElementById("groupNameInput").value.trim();
  if (!name) return;

  const checkboxes = document.getElementById("groupSiteCheckboxes").querySelectorAll("input:checked");
  const sites = Array.from(checkboxes).map((cb) => cb.value);

  if (sites.length === 0) return;

  const costVal = parseInt(document.getElementById("groupCostInput").value, 10);
  const cost = costVal >= 1 ? costVal : null;

  let resp;
  if (editingGroupId) {
    resp = await chrome.runtime.sendMessage({
      type: "updateGroup",
      id: editingGroupId,
      name,
      sites,
      cost,
    });
  } else {
    resp = await chrome.runtime.sendMessage({
      type: "addGroup",
      name,
      sites,
      cost,
    });
  }

  if (resp.ok) {
    closeGroupEditor();
    await refreshState();
    render();
  } else {
    setStatus(resp.error || "Failed to save group");
  }
}

async function removeGroup(id) {
  const resp = await chrome.runtime.sendMessage({ type: "removeGroup", id });
  if (resp.ok) {
    await refreshState();
    render();
  }
}

function startAbstinenceTimers() {
  if (abstinenceTimerInterval) clearInterval(abstinenceTimerInterval);
  updateAbstinenceTimers();
  abstinenceTimerInterval = setInterval(updateAbstinenceTimers, 60000);
}

function updateAbstinenceTimers() {
  const now = Date.now();
  const els = document.querySelectorAll("[data-since]");
  for (const el of els) {
    const since = new Date(el.dataset.since).getTime();
    const ms = now - since;
    el.textContent = ms > 0 ? formatDuration(ms) : "";
  }
}

function renderConfig() {
  const config = state.config || {};

  document.getElementById("cooldownSelect").value = String(
    config.cooldownMinutes || 30
  );

  const unlockMode = config.unlockMode === "section" ? "section" : "all";
  document.getElementById("unlockModeSelect").value = unlockMode;

  const sectionSelect = document.getElementById("unlockSectionSelect");
  const sections = getTaskSections();
  sectionSelect.innerHTML = "";

  const configuredSection = (config.unlockSection || "").trim();
  if (!configuredSection) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = sections.length === 0 ? "No sections" : "Select section";
    sectionSelect.appendChild(placeholder);
  }

  if (configuredSection && !sections.includes(configuredSection)) {
    const missingOption = document.createElement("option");
    missingOption.value = configuredSection;
    missingOption.textContent = `${configuredSection} (missing)`;
    sectionSelect.appendChild(missingOption);
  }

  if (sections.length > 0) {
    for (const section of sections) {
      const option = document.createElement("option");
      option.value = section;
      option.textContent = section;
      sectionSelect.appendChild(option);
    }
  }

  sectionSelect.value = configuredSection;
  sectionSelect.disabled = unlockMode !== "section" || sections.length === 0;

  document.getElementById("mdPath").textContent = config.markdownPath || "not configured";
}

function renderBackupStatus() {
  const localText = backupStatus.latestLocalBackupAt
    ? `local ${backupStatus.localBackups} (${formatDateTime(backupStatus.latestLocalBackupAt)})`
    : `local ${backupStatus.localBackups}`;

  const syncText = backupStatus.latestSyncAt
    ? `sync ${formatDateTime(backupStatus.latestSyncAt)}`
    : "sync never";

  const status = statusMessage
    ? `${statusMessage} | ${localText} | ${syncText}`
    : `${localText} | ${syncText}`;

  document.getElementById("backupStatusText").textContent = status;
}
