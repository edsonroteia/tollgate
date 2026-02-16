/* global chrome */

let state = {};
let unlockIntervals = [];

document.addEventListener("DOMContentLoaded", async () => {
  state = await chrome.runtime.sendMessage({ type: "getState" });
  render();

  // Add site
  const addBtn = document.getElementById("siteAddBtn");
  const input = document.getElementById("siteInput");

  addBtn.addEventListener("click", () => addSite(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSite(input);
  });

  // Cooldown select
  document.getElementById("cooldownSelect").addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "updateConfig",
      config: { cooldownMinutes: parseInt(e.target.value, 10) },
    });
  });
});

async function addSite(input) {
  const val = input.value.trim();
  if (!val) return;
  const resp = await chrome.runtime.sendMessage({ type: "addSite", site: val });
  if (resp.ok) {
    state.blockedSites = resp.blockedSites;
    input.value = "";
    render();
  }
}

function render() {
  renderStats();
  renderSites();
  renderUnlocks();
  renderConfig();
}

function renderStats() {
  const streak = state.streak || { current: 0 };
  document.getElementById("streakValue").textContent = streak.current;

  const tasks = state.tasks || [];
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = tasks.filter(
    (t) => t.completed && t.completedAt && t.completedAt.startsWith(today)
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
    ([, u]) => new Date(u.expiresAt).getTime() > now
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

    item.appendChild(name);
    item.appendChild(timer);
    list.appendChild(item);
  }
}

function renderConfig() {
  const config = state.config || {};
  document.getElementById("cooldownSelect").value = String(
    config.cooldownMinutes || 30
  );
  document.getElementById("mdPath").textContent =
    config.markdownPath || "not configured";
}
