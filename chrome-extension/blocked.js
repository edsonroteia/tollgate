/* global chrome */

// ── State ───────────────────────────────────────────────────────────

let state = {
  blockedSites: [],
  tasks: [],
  config: {
    cooldownMinutes: 30,
    unlockMode: "all",
    unlockSection: "",
  },
  streak: { current: 0, longest: 0, lastDate: null },
  timeLog: [],
  unlocks: {},
};

const site = new URLSearchParams(location.search).get("site") || "";
let countdownInterval = null;
const collapsedCompositeTasks = new Set();
let editingTaskId = null;
let pendingEditorFocusTaskId = null;

const dragState = {
  draggedTaskId: null,
  dropTaskId: null,
  dropPosition: null,
};

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

    const { tasksById, childrenByParent } = buildTaskTree(tasks);
    const rendered = new Set();

    for (const rootTask of childrenByParent.get(null) || []) {
      sectionEl.appendChild(
        createTaskElement(rootTask, tasksById, childrenByParent, 0, rendered)
      );
    }

    // Safety for malformed parent chains/cycles.
    for (const task of tasks) {
      if (!rendered.has(task.id)) {
        sectionEl.appendChild(
          createTaskElement(task, tasksById, childrenByParent, 0, rendered)
        );
      }
    }

    container.appendChild(sectionEl);
  }

  focusPendingTaskEditor(container);
}

function focusPendingTaskEditor(container) {
  if (!pendingEditorFocusTaskId) return;

  const input = container.querySelector(
    `.task-edit-input[data-task-id="${pendingEditorFocusTaskId}"]`
  );

  pendingEditorFocusTaskId = null;

  if (input) {
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
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

function createTaskElement(task, tasksById, childrenByParent, depth, rendered) {
  rendered.add(task.id);
  const children = childrenByParent.get(task.id) || [];
  const isComposite = children.length > 0;
  const isCollapsed = isComposite && collapsedCompositeTasks.has(task.id);
  const isEditing = editingTaskId === task.id;

  const node = document.createElement("div");
  node.className = "task-node";
  if (depth > 0) node.classList.add("task-node--nested");

  const el = document.createElement("div");
  el.className = "task-item" + (task.completed ? " completed" : "");
  if (isComposite) el.classList.add("task-item--composite");
  if (isEditing) el.classList.add("task-item--editing");
  el.dataset.taskId = task.id;
  el.addEventListener("dragover", (event) => handleTaskDragOver(event, task.id));
  el.addEventListener("drop", (event) => {
    void handleTaskDrop(event, task.id);
  });

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
  checkbox.addEventListener("change", () => {
    void toggleTask(task.id);
  });
  controls.appendChild(checkbox);

  const dragHandle = document.createElement("span");
  dragHandle.className = "task-drag-handle";
  dragHandle.textContent = "::";
  dragHandle.title = "Drag to reorder";
  dragHandle.setAttribute("draggable", "true");
  dragHandle.addEventListener("dragstart", (event) =>
    handleTaskDragStart(event, task.id)
  );
  dragHandle.addEventListener("dragend", handleTaskDragEnd);
  controls.appendChild(dragHandle);

  const content = document.createElement("div");
  content.className = "task-content";

  if (isEditing) {
    content.appendChild(createTaskEditor(task));
  } else {
    const contentHeader = document.createElement("div");
    contentHeader.className = "task-content-header";

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = task.text;
    text.addEventListener("dblclick", () => startTaskEdit(task.id));
    contentHeader.appendChild(text);

    const headerRight = document.createElement("div");
    headerRight.className = "task-header-right";

    if (isComposite) {
      headerRight.appendChild(
        createCompositeProgressElement(task.id, childrenByParent)
      );
    }

    headerRight.appendChild(createTaskActions(task.id));
    contentHeader.appendChild(headerRight);

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
  }

  el.appendChild(controls);
  el.appendChild(content);
  node.appendChild(el);

  if (isComposite && !isCollapsed) {
    const childrenEl = document.createElement("div");
    childrenEl.className = "task-children";
    for (const child of children) {
      if (!rendered.has(child.id)) {
        childrenEl.appendChild(
          createTaskElement(child, tasksById, childrenByParent, depth + 1, rendered)
        );
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

function createTaskEditor(task) {
  const row = document.createElement("div");
  row.className = "task-edit-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "task-edit-input";
  input.value = formatTaskInputText(task);
  input.dataset.taskId = task.id;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTaskEdit(task.id, input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelTaskEdit();
    }
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "task-inline-btn task-inline-btn--save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    void saveTaskEdit(task.id, input.value);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "task-inline-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", cancelTaskEdit);

  row.appendChild(input);
  row.appendChild(saveBtn);
  row.appendChild(cancelBtn);
  return row;
}

function createTaskActions(taskId) {
  const menu = document.createElement("div");
  menu.className = "task-action-menu";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "task-action-trigger";
  trigger.textContent = "<";
  trigger.setAttribute("aria-label", "Show task actions");
  trigger.title = "Show actions";

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "task-action-btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => startTaskEdit(taskId));

  const subtaskBtn = document.createElement("button");
  subtaskBtn.type = "button";
  subtaskBtn.className = "task-action-btn";
  subtaskBtn.textContent = "+Sub";
  subtaskBtn.addEventListener("click", () => {
    void addSubtask(taskId);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "task-action-btn task-action-btn--danger";
  deleteBtn.textContent = "Del";
  deleteBtn.addEventListener("click", () => {
    void deleteTask(taskId);
  });

  actions.appendChild(editBtn);
  actions.appendChild(subtaskBtn);
  actions.appendChild(deleteBtn);

  menu.appendChild(trigger);
  menu.appendChild(actions);
  return menu;
}

function startTaskEdit(taskId) {
  editingTaskId = taskId;
  pendingEditorFocusTaskId = taskId;
  clearDragState();
  renderTasks();
}

function cancelTaskEdit() {
  editingTaskId = null;
  pendingEditorFocusTaskId = null;
  renderTasks();
}

function formatTaskInputText(task) {
  let text = task.text || "";
  if (task.dueDate) {
    text += ` (due: ${task.dueDate})`;
  }
  if (task.recurring) {
    text += ` (${task.recurring})`;
  }
  return text;
}

function parseTaskInput(text) {
  let parsedText = (text || "").trim();
  let dueDate = null;
  let recurring = null;

  const dueMatch = parsedText.match(/\(due:\s*(\d{4}-\d{2}-\d{2})\)/);
  if (dueMatch) {
    dueDate = dueMatch[1];
    parsedText = parsedText.replace(dueMatch[0], "").trim();
  }

  const recurMatch = parsedText.match(/\((daily|weekly)\)/);
  if (recurMatch) {
    recurring = recurMatch[1];
    parsedText = parsedText.replace(recurMatch[0], "").trim();
  }

  return { text: parsedText, dueDate, recurring };
}

async function saveTaskEdit(taskId, text) {
  const task = (state.tasks || []).find((item) => item.id === taskId);
  if (!task) return;

  const parsed = parseTaskInput(text);
  if (!parsed.text) {
    showToast("Task cannot be empty");
    return;
  }

  task.text = parsed.text;
  task.dueDate = parsed.dueDate;
  task.recurring = parsed.recurring;

  editingTaskId = null;
  pendingEditorFocusTaskId = null;

  await persistTasks("Task updated");
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
    done = direct.filter((item) => item.completed).length;
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

function getSubtreeTaskIds(taskId, childrenByParent) {
  const ids = [];
  const stack = [taskId];
  const seen = new Set();

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    ids.push(currentId);

    const children = childrenByParent.get(currentId) || [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i].id);
    }
  }

  return ids;
}

function handleTaskDragStart(event, taskId) {
  if (!event.dataTransfer) return;

  dragState.draggedTaskId = taskId;
  dragState.dropTaskId = null;
  dragState.dropPosition = null;

  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", taskId);

  const item = event.target.closest(".task-item");
  if (item) item.classList.add("dragging");
}

function handleTaskDragOver(event, targetTaskId) {
  const draggedTaskId = dragState.draggedTaskId;
  if (!draggedTaskId) return;

  const dropPosition = getDropPosition(event);
  if (!canDropTask(draggedTaskId, targetTaskId)) return;

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  setTaskDropIndicator(targetTaskId, dropPosition);
}

async function handleTaskDrop(event, targetTaskId) {
  event.preventDefault();

  const draggedTaskId = dragState.draggedTaskId;
  const dropPosition = getDropPosition(event);

  if (!draggedTaskId || !canDropTask(draggedTaskId, targetTaskId)) {
    clearDragState();
    return;
  }

  await reorderTask(draggedTaskId, targetTaskId, dropPosition);
  clearDragState();
}

function handleTaskDragEnd() {
  clearDragState();
}

function clearDragState() {
  dragState.draggedTaskId = null;
  dragState.dropTaskId = null;
  dragState.dropPosition = null;
  clearTaskDropIndicators();

  document
    .querySelectorAll(".task-item.dragging")
    .forEach((item) => item.classList.remove("dragging"));
}

function getDropPosition(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = event.clientY - rect.top;
  return y < rect.height / 2 ? "before" : "after";
}

function canDropTask(draggedTaskId, targetTaskId) {
  const { tasksById, childrenByParent } = buildTaskTree(state.tasks || []);
  const dragged = tasksById.get(draggedTaskId);
  const target = tasksById.get(targetTaskId);

  if (!dragged || !target || dragged.id === target.id) {
    return false;
  }

  if ((dragged.section || "Tasks") !== (target.section || "Tasks")) {
    return false;
  }

  const draggedParentId = getParentId(dragged, tasksById);
  const targetParentId = getParentId(target, tasksById);
  if (draggedParentId !== targetParentId) {
    return false;
  }

  const draggedSubtree = new Set(getSubtreeTaskIds(dragged.id, childrenByParent));
  if (draggedSubtree.has(target.id)) {
    return false;
  }

  return true;
}

async function reorderTask(draggedTaskId, targetTaskId, position) {
  const { tasksById, childrenByParent } = buildTaskTree(state.tasks || []);
  const draggedTask = tasksById.get(draggedTaskId);
  const targetTask = tasksById.get(targetTaskId);

  if (!draggedTask || !targetTask) return;

  const movedIds = new Set(getSubtreeTaskIds(draggedTask.id, childrenByParent));
  const movingTasks = state.tasks.filter((task) => movedIds.has(task.id));
  const remainingTasks = state.tasks.filter((task) => !movedIds.has(task.id));

  let insertIndex = -1;

  if (position === "before") {
    insertIndex = remainingTasks.findIndex((task) => task.id === targetTask.id);
  } else {
    const targetIds = new Set(getSubtreeTaskIds(targetTask.id, childrenByParent));
    let lastTargetIndex = -1;
    for (let i = 0; i < remainingTasks.length; i++) {
      if (targetIds.has(remainingTasks[i].id)) {
        lastTargetIndex = i;
      }
    }
    insertIndex = lastTargetIndex + 1;
  }

  if (insertIndex < 0) return;

  state.tasks = [
    ...remainingTasks.slice(0, insertIndex),
    ...movingTasks,
    ...remainingTasks.slice(insertIndex),
  ];

  await persistTasks("Task order updated");
}

function setTaskDropIndicator(taskId, position) {
  if (dragState.dropTaskId === taskId && dragState.dropPosition === position) {
    return;
  }

  clearTaskDropIndicators();

  const row = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
  if (!row) return;

  row.classList.add(position === "before" ? "drag-over-before" : "drag-over-after");
  dragState.dropTaskId = taskId;
  dragState.dropPosition = position;
}

function clearTaskDropIndicators() {
  document
    .querySelectorAll(".task-item.drag-over-before, .task-item.drag-over-after")
    .forEach((item) => {
      item.classList.remove("drag-over-before", "drag-over-after");
    });
}

function getUnlockRequirement() {
  const tasks = state.tasks || [];
  const config = state.config || {};
  const mode = config.unlockMode === "section" ? "section" : "all";

  if (mode === "section") {
    const section = (config.unlockSection || "").trim();
    const scopedTasks = section
      ? tasks.filter((task) => (task.section || "Tasks") === section)
      : [];
    const done = scopedTasks.filter((task) => task.completed).length;
    const total = scopedTasks.length;
    const ready = total > 0 && done === total;

    return {
      mode,
      section,
      done,
      total,
      ready,
      empty: total === 0,
    };
  }

  const done = tasks.filter((task) => task.completed).length;
  const total = tasks.length;

  return {
    mode,
    section: "",
    done,
    total,
    ready: total > 0 && done === total,
    empty: total === 0,
  };
}

function renderProgress() {
  const requirement = getUnlockRequirement();
  const done = requirement.done;
  const total = requirement.total;

  document.getElementById("progressLabel").textContent = `${done}/${total}`;

  const circumference = 2 * Math.PI * 30; // r=30
  const ratio = total > 0 ? done / total : 0;
  const offset = circumference * (1 - ratio);
  document.getElementById("progressFill").style.strokeDashoffset = offset;

  // Change ring color when requirement is completed
  if (requirement.ready) {
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
    (entry) => entry.unlockedAt && entry.unlockedAt.startsWith(today)
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

  const parts = Object.entries(siteTimes).map(([name, mins]) => `${mins}min ${name}`);
  document.getElementById("timeLog").textContent = "Today: " + parts.join(", ");
}

function updateUnlockButton() {
  const requirement = getUnlockRequirement();
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
  btn.disabled = !requirement.ready;

  if (requirement.mode === "section") {
    if (!requirement.section) {
      hint.textContent = "select unlock section in settings";
    } else if (requirement.empty) {
      hint.textContent = `no tasks in \"${requirement.section}\"`;
    } else {
      hint.textContent = requirement.ready
        ? ""
        : `complete section \"${requirement.section}\"`;
    }
    return;
  }

  hint.textContent = requirement.ready ? "" : "all tasks must be completed";
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

async function persistTasks(toastText = "") {
  await sendMessage({ type: "updateTasks", tasks: state.tasks });
  render();
  if (toastText) showToast(toastText);
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

  await persistTasks();
}

async function addTask(text) {
  const parsed = parseTaskInput(text);
  if (!parsed.text) {
    showToast("Task cannot be empty");
    return;
  }

  const newTask = {
    id: crypto.randomUUID(),
    text: parsed.text,
    completed: false,
    parentId: null,
    section: "Tasks",
    dueDate: parsed.dueDate,
    recurring: parsed.recurring,
    completedAt: null,
  };

  if (!state.tasks) state.tasks = [];
  state.tasks.push(newTask);

  await persistTasks("Task added");
}

async function addSubtask(parentTaskId) {
  const { tasksById, childrenByParent } = buildTaskTree(state.tasks || []);
  const parent = tasksById.get(parentTaskId);
  if (!parent) return;

  const newTask = {
    id: crypto.randomUUID(),
    text: "New subtask",
    completed: false,
    parentId: parent.id,
    section: parent.section || "Tasks",
    dueDate: null,
    recurring: null,
    completedAt: null,
  };

  const subtreeIds = new Set(getSubtreeTaskIds(parent.id, childrenByParent));
  let insertIndex = -1;
  for (let i = 0; i < state.tasks.length; i++) {
    if (subtreeIds.has(state.tasks[i].id)) {
      insertIndex = i;
    }
  }

  state.tasks.splice(insertIndex + 1, 0, newTask);
  collapsedCompositeTasks.delete(parent.id);
  syncCompositeCompletion(state.tasks || []);

  editingTaskId = newTask.id;
  pendingEditorFocusTaskId = newTask.id;

  await persistTasks("Subtask added");
}

async function deleteTask(taskId) {
  const { childrenByParent } = buildTaskTree(state.tasks || []);
  const subtreeIds = new Set(getSubtreeTaskIds(taskId, childrenByParent));
  if (subtreeIds.size === 0) return;

  const hasChildren = subtreeIds.size > 1;
  const message = hasChildren
    ? "Delete this task and all of its subtasks?"
    : "Delete this task?";

  if (!window.confirm(message)) {
    return;
  }

  state.tasks = (state.tasks || []).filter((task) => !subtreeIds.has(task.id));

  if (editingTaskId && subtreeIds.has(editingTaskId)) {
    editingTaskId = null;
    pendingEditorFocusTaskId = null;
  }

  for (const id of subtreeIds) {
    collapsedCompositeTasks.delete(id);
  }

  syncCompositeCompletion(state.tasks || []);
  await persistTasks("Task deleted");
}

async function handleUnlock() {
  const resp = await sendMessage({ type: "unlock", site });
  if (!resp.ok) {
    showToast(resp.error || "Unlock requirements not met");
    return;
  }

  state.unlocks[site] = resp.unlock;
  render();
  startCountdownIfNeeded();

  // Navigate to the site
  setTimeout(() => {
    location.href = "https://" + site;
  }, 500);
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
