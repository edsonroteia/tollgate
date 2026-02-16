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
const collapsedCompositeTasks = new Set();

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

  changed = syncCompositeCompletion(state.tasks || []) || changed;

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
  const allTasks = state.tasks || [];
  pruneCollapsedCompositeState(allTasks);

  // Group tasks by section
  const sections = new Map();
  for (const task of allTasks) {
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

    const { childrenByParent } = buildTaskTree(tasks);
    const rendered = new Set();

    for (const rootTask of childrenByParent.get(null) || []) {
      sectionEl.appendChild(createTaskElement(rootTask, childrenByParent, 0, rendered));
    }

    // Safety for malformed parent chains/cycles.
    for (const task of tasks) {
      if (!rendered.has(task.id)) {
        sectionEl.appendChild(createTaskElement(task, childrenByParent, 0, rendered));
      }
    }

    container.appendChild(sectionEl);
  }
}

function pruneCollapsedCompositeState(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  for (const id of collapsedCompositeTasks) {
    if (!ids.has(id)) {
      collapsedCompositeTasks.delete(id);
    }
  }
}

function getParentId(task, tasksById) {
  if (!task.parentId || task.parentId === task.id) return null;
  return tasksById.has(task.parentId) ? task.parentId : null;
}

function buildTaskTree(tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map();

  for (const task of tasks) {
    const parentId = getParentId(task, tasksById);
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(task);
  }

  return { tasksById, childrenByParent };
}

function createTaskElement(task, childrenByParent, depth, rendered) {
  rendered.add(task.id);
  const children = childrenByParent.get(task.id) || [];
  const isComposite = children.length > 0;
  const isCollapsed = isComposite && collapsedCompositeTasks.has(task.id);

  const node = document.createElement("div");
  node.className = "task-node";
  if (depth > 0) node.classList.add("task-node--nested");

  const el = document.createElement("div");
  el.className = "task-item" + (task.completed ? " completed" : "");
  if (isComposite) el.classList.add("task-item--composite");

  const controls = document.createElement("div");
  controls.className = "task-controls";

  if (isComposite) {
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "task-collapse-toggle";
    collapseBtn.textContent = isCollapsed ? ">" : "v";
    collapseBtn.setAttribute("aria-expanded", String(!isCollapsed));
    collapseBtn.setAttribute(
      "aria-label",
      isCollapsed ? "Show subtasks" : "Hide subtasks"
    );
    collapseBtn.addEventListener("click", () => {
      if (collapsedCompositeTasks.has(task.id)) {
        collapsedCompositeTasks.delete(task.id);
      } else {
        collapsedCompositeTasks.add(task.id);
      }
      renderTasks();
    });
    controls.appendChild(collapseBtn);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "task-collapse-spacer";
    spacer.setAttribute("aria-hidden", "true");
    controls.appendChild(spacer);
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.addEventListener("change", () => toggleTask(task.id));
  controls.appendChild(checkbox);

  const content = document.createElement("div");
  content.className = "task-content";

  const contentHeader = document.createElement("div");
  contentHeader.className = "task-content-header";

  const text = document.createElement("span");
  text.className = "task-text";
  text.textContent = task.text;
  contentHeader.appendChild(text);

  if (isComposite) {
    contentHeader.appendChild(createCompositeProgressElement(task.id, childrenByParent));
  }

  content.appendChild(contentHeader);

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

  el.appendChild(controls);
  el.appendChild(content);
  node.appendChild(el);

  if (isComposite && !isCollapsed) {
    const childrenEl = document.createElement("div");
    childrenEl.className = "task-children";
    for (const child of children) {
      if (!rendered.has(child.id)) {
        childrenEl.appendChild(createTaskElement(child, childrenByParent, depth + 1, rendered));
      }
    }
    if (childrenEl.childElementCount > 0) {
      node.appendChild(childrenEl);
    }
  } else if (isComposite && isCollapsed) {
    // Mark hidden descendants so fallback rendering doesn't show them as top-level rows.
    markDescendantsAsRendered(task.id, childrenByParent, rendered);
  }

  return node;
}

function markDescendantsAsRendered(taskId, childrenByParent, rendered) {
  const stack = [...(childrenByParent.get(taskId) || [])];
  const visited = new Set([taskId]);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    rendered.add(current.id);

    for (const child of childrenByParent.get(current.id) || []) {
      stack.push(child);
    }
  }
}

function getCompositeProgress(taskId, childrenByParent) {
  const visited = new Set([taskId]);
  const stack = [...(childrenByParent.get(taskId) || [])];
  let done = 0;
  let total = 0;

  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || visited.has(task.id)) continue;
    visited.add(task.id);

    const children = childrenByParent.get(task.id) || [];
    if (children.length === 0) {
      total += 1;
      if (task.completed) done += 1;
      continue;
    }

    for (const child of children) {
      stack.push(child);
    }
  }

  if (total === 0) {
    const direct = childrenByParent.get(taskId) || [];
    total = direct.length;
    done = direct.filter((task) => task.completed).length;
  }

  return { done, total };
}

function createCompositeProgressElement(taskId, childrenByParent) {
  const { done, total } = getCompositeProgress(taskId, childrenByParent);
  const ratio = total > 0 ? done / total : 0;

  const r = 8;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - ratio);

  const wrapper = document.createElement("span");
  wrapper.className = "task-subprogress";
  if (total > 0 && done === total) {
    wrapper.classList.add("complete");
  }

  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 20 20");
  ring.classList.add("task-subprogress-ring");

  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("cx", "10");
  track.setAttribute("cy", "10");
  track.setAttribute("r", String(r));
  track.classList.add("task-subprogress-track");

  const fill = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  fill.setAttribute("cx", "10");
  fill.setAttribute("cy", "10");
  fill.setAttribute("r", String(r));
  fill.classList.add("task-subprogress-fill");
  fill.style.strokeDasharray = String(circumference);
  fill.style.strokeDashoffset = String(offset);

  ring.appendChild(track);
  ring.appendChild(fill);
  wrapper.appendChild(ring);

  const label = document.createElement("span");
  label.className = "task-subprogress-label";
  label.textContent = `${done}/${total}`;
  wrapper.appendChild(label);

  return wrapper;
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

function setTaskCompletion(task, completed, timestamp) {
  task.completed = completed;
  task.completedAt = completed ? timestamp : null;
}

function collectDescendants(taskId, childrenByParent) {
  const descendants = [];
  const stack = [...(childrenByParent.get(taskId) || [])];
  const seen = new Set([taskId]);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    descendants.push(current);

    for (const child of childrenByParent.get(current.id) || []) {
      stack.push(child);
    }
  }

  return descendants;
}

function syncAncestorCompletion(task, tasksById, childrenByParent, timestamp) {
  const seen = new Set();
  let parentId = getParentId(task, tasksById);

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tasksById.get(parentId);
    if (!parent) break;

    const children = childrenByParent.get(parent.id) || [];
    if (children.length === 0) break;

    const shouldBeCompleted = children.every((child) => child.completed);
    if (parent.completed !== shouldBeCompleted) {
      setTaskCompletion(parent, shouldBeCompleted, timestamp);
    } else if (!shouldBeCompleted) {
      parent.completedAt = null;
    }

    parentId = getParentId(parent, tasksById);
  }
}

function syncCompositeCompletion(tasks) {
  const { childrenByParent } = buildTaskTree(tasks);
  const visited = new Set();
  const timestamp = new Date().toISOString();
  let changed = false;

  const walk = (task) => {
    if (!task || visited.has(task.id)) return;
    visited.add(task.id);

    for (const child of childrenByParent.get(task.id) || []) {
      walk(child);
    }

    const children = childrenByParent.get(task.id) || [];
    if (children.length > 0) {
      const shouldBeCompleted = children.every((child) => child.completed);
      if (task.completed !== shouldBeCompleted) {
        setTaskCompletion(task, shouldBeCompleted, timestamp);
        changed = true;
      } else if (!shouldBeCompleted) {
        if (task.completedAt !== null) {
          changed = true;
        }
        task.completedAt = null;
      }
    }
  };

  for (const root of childrenByParent.get(null) || []) {
    walk(root);
  }

  for (const task of tasks) {
    walk(task);
  }

  return changed;
}

async function toggleTask(taskId) {
  const { tasksById, childrenByParent } = buildTaskTree(state.tasks || []);
  const task = tasksById.get(taskId);
  if (!task) return;

  const timestamp = new Date().toISOString();
  const nextCompleted = !task.completed;
  setTaskCompletion(task, nextCompleted, timestamp);

  for (const descendant of collectDescendants(task.id, childrenByParent)) {
    setTaskCompletion(descendant, nextCompleted, timestamp);
  }

  syncAncestorCompletion(task, tasksById, childrenByParent, timestamp);

  await sendMessage({ type: "updateTasks", tasks: state.tasks });
  render();
}

async function addTask(text) {
  const newTask = {
    id: crypto.randomUUID(),
    text,
    completed: false,
    parentId: null,
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
