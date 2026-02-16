/* global chrome */

// ── State ───────────────────────────────────────────────────────────

let state = {
  blockedSites: [],
  tasks: [],
  config: { cooldownMinutes: 30 },
  streak: { current: 0, longest: 0, lastDate: null },
  timeLog: [],
  unlocks: {},
};

const site = new URLSearchParams(location.search).get("site") || "";
let countdownInterval = null;

// ── Init ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("blockedSite").textContent = site;
  document.getElementById("unlockSiteName").textContent = site;

  state = await sendMessage({ type: "getState" });
  resetRecurringTasks();
  render();
  startCountdownIfNeeded();

  // Add task on Enter
  document.getElementById("addTaskInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      addTask(e.target.value.trim());
      e.target.value = "";
    }
  });

  // Unlock button
  document.getElementById("unlockBtn").addEventListener("click", handleUnlock);
});

// ── Recurring task reset ────────────────────────────────────────────

function resetRecurringTasks() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let changed = false;

  // Monday of this week (ISO week)
  const dayOfWeek = now.getDay() || 7; // Sunday=7
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const weekStart = monday.toISOString().slice(0, 10);

  for (const task of state.tasks || []) {
    if (!task.recurring || !task.completed || !task.completedAt) continue;

    const completedDate = task.completedAt.slice(0, 10);

    if (task.recurring === "daily" && completedDate < today) {
      task.completed = false;
      task.completedAt = null;
      changed = true;
    } else if (task.recurring === "weekly" && completedDate < weekStart) {
      task.completed = false;
      task.completedAt = null;
      changed = true;
    }
  }

  if (changed) {
    sendMessage({ type: "updateTasks", tasks: state.tasks });
  }
}

// ── Render ───────────────────────────────────────────────────────────

function render() {
  renderTasks();
  renderProgress();
  renderStats();
  renderTimeLog();
  updateUnlockButton();
}

function renderTasks() {
  const container = document.getElementById("tasksContainer");
  container.innerHTML = "";

  // Group tasks by section
  const sections = new Map();
  for (const task of state.tasks || []) {
    const sec = task.section || "Tasks";
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(task);
  }

  if (sections.size === 0) {
    container.innerHTML =
      '<p style="text-align:center;color:var(--text-muted);font-size:var(--font-size-sm)">No tasks yet. Add one below.</p>';
    return;
  }

  for (const [name, tasks] of sections) {
    const sectionEl = document.createElement("div");
    sectionEl.className = "section";

    const headerEl = document.createElement("div");
    headerEl.className = "section-header";
    headerEl.textContent = name;
    sectionEl.appendChild(headerEl);

    for (const task of tasks) {
      sectionEl.appendChild(createTaskElement(task));
    }

    container.appendChild(sectionEl);
  }
}

function createTaskElement(task) {
  const el = document.createElement("div");
  el.className = "task-item" + (task.completed ? " completed" : "");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.addEventListener("change", () => toggleTask(task.id));

  const content = document.createElement("div");
  content.className = "task-content";

  const text = document.createElement("span");
  text.className = "task-text";
  text.textContent = task.text;
  content.appendChild(text);

  // Meta badges
  if (task.dueDate || task.recurring) {
    const meta = document.createElement("div");
    meta.className = "task-meta";

    if (task.dueDate) {
      const badge = document.createElement("span");
      badge.className = "task-badge task-badge--due";
      const due = new Date(task.dueDate + "T00:00:00");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (due < today && !task.completed) {
        badge.classList.add("overdue");
      }
      badge.textContent = "due: " + formatDate(task.dueDate);
      meta.appendChild(badge);
    }

    if (task.recurring) {
      const badge = document.createElement("span");
      badge.className = "task-badge task-badge--recurring";
      badge.textContent = task.recurring;
      meta.appendChild(badge);
    }

    content.appendChild(meta);
  }

  el.appendChild(checkbox);
  el.appendChild(content);
  return el;
}

function renderProgress() {
  const tasks = state.tasks || [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.completed).length;

  document.getElementById("progressLabel").textContent = `${done}/${total}`;

  const circumference = 2 * Math.PI * 30; // r=30
  const ratio = total > 0 ? done / total : 0;
  const offset = circumference * (1 - ratio);
  document.getElementById("progressFill").style.strokeDashoffset = offset;

  // Change ring color when all done
  if (total > 0 && done === total) {
    document.getElementById("progressFill").style.stroke = "var(--success)";
  } else {
    document.getElementById("progressFill").style.stroke = "var(--accent)";
  }
}

function renderStats() {
  const streak = state.streak || { current: 0, longest: 0 };
  document.getElementById("streakCurrent").textContent =
    streak.current + (streak.current === 1 ? " day" : " days");
  document.getElementById("streakLongest").textContent =
    streak.longest + (streak.longest === 1 ? " day" : " days");
}

function renderTimeLog() {
  const log = state.timeLog || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = log.filter(
    (e) => e.unlockedAt && e.unlockedAt.startsWith(today)
  );

  if (todayEntries.length === 0) {
    document.getElementById("timeLog").textContent = "";
    return;
  }

  // Sum time per site
  const siteTimes = {};
  for (const entry of todayEntries) {
    const end = entry.lockedAt ? new Date(entry.lockedAt) : new Date();
    const start = new Date(entry.unlockedAt);
    const mins = Math.round((end - start) / 60000);
    siteTimes[entry.site] = (siteTimes[entry.site] || 0) + mins;
  }

  const parts = Object.entries(siteTimes).map(
    ([s, m]) => `${m}min ${s}`
  );
  document.getElementById("timeLog").textContent = "Today: " + parts.join(", ");
}

function updateUnlockButton() {
  const tasks = state.tasks || [];
  const allDone = tasks.length > 0 && tasks.every((t) => t.completed);
  const btn = document.getElementById("unlockBtn");
  const hint = document.getElementById("unlockHint");

  // Check if currently unlocked
  const unlock = (state.unlocks || {})[site];
  if (unlock && new Date(unlock.expiresAt) > new Date()) {
    btn.textContent = "Site is unlocked";
    btn.disabled = true;
    hint.textContent = "";
    return;
  }

  btn.textContent = "Unlock " + site;
  btn.disabled = !allDone;
  hint.textContent = allDone ? "" : "all tasks must be completed";
}

// ── Countdown ───────────────────────────────────────────────────────

function startCountdownIfNeeded() {
  const unlock = (state.unlocks || {})[site];
  if (!unlock) return;

  const expires = new Date(unlock.expiresAt);
  if (expires <= new Date()) return;

  const bar = document.getElementById("countdownBar");
  bar.hidden = false;

  countdownInterval = setInterval(() => {
    const remaining = expires - new Date();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      bar.hidden = true;
      updateUnlockButton();
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById("countdownTimer").textContent =
      `${mins}:${String(secs).padStart(2, "0")}`;
  }, 1000);
}

// ── Actions ─────────────────────────────────────────────────────────

async function toggleTask(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;

  await sendMessage({ type: "updateTasks", tasks: state.tasks });
  render();
}

async function addTask(text) {
  const newTask = {
    id: crypto.randomUUID(),
    text,
    completed: false,
    section: "Tasks",
    dueDate: null,
    recurring: null,
    completedAt: null,
  };

  // Parse inline modifiers
  const dueMatch = text.match(/\(due:\s*(\d{4}-\d{2}-\d{2})\)/);
  if (dueMatch) {
    newTask.dueDate = dueMatch[1];
    newTask.text = text.replace(dueMatch[0], "").trim();
  }

  const recurMatch = text.match(/\((daily|weekly)\)/);
  if (recurMatch) {
    newTask.recurring = recurMatch[1];
    newTask.text = text.replace(recurMatch[0], "").trim();
  }

  if (!state.tasks) state.tasks = [];
  state.tasks.push(newTask);

  await sendMessage({ type: "updateTasks", tasks: state.tasks });
  render();
  showToast("Task added");
}

async function handleUnlock() {
  const resp = await sendMessage({ type: "unlock", site });
  if (resp.ok) {
    state.unlocks[site] = resp.unlock;
    render();
    startCountdownIfNeeded();

    // Navigate to the site
    setTimeout(() => {
      location.href = "https://" + site;
    }, 500);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.hidden = false;
  toast.classList.add("visible");
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => {
      toast.hidden = true;
    }, 300);
  }, 2000);
}
