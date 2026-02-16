/* global chrome */

let state = {};
let backupStatus = {
  localBackups: 0,
  latestLocalBackupAt: null,
  latestSyncAt: null,
};
let unlockIntervals = [];
let statusMessage = "";

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
  renderUnlocks();
  renderConfig();
  renderBackupStatus();
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
    pill.textContent = site;

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
        renderSites();
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

  for (const [site, unlock] of active) {
    const item = document.createElement("div");
    item.className = "unlock-item";

    const name = document.createElement("span");
    name.textContent = site;

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
      await chrome.runtime.sendMessage({ type: "relock", site });
      delete state.unlocks[site];
      renderUnlocks();
    });

    item.appendChild(name);
    item.appendChild(timer);
    item.appendChild(relockBtn);
    list.appendChild(item);
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
