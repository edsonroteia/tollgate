/**
 * Markdown task list parser/serializer.
 *
 * Format:
 *   ## Section Name
 *   - [ ] Task text
 *     - [ ] Nested subtask
 *   - [x] Completed task (due: 2026-02-17)
 *   - [ ] Recurring task (daily)
 */

const DEFAULT_SECTION = "Tasks";
const INDENT_WIDTH = 2;

function getIndentLevel(indent) {
  const expanded = indent.replace(/\t/g, " ".repeat(INDENT_WIDTH));
  return Math.floor(expanded.length / INDENT_WIDTH);
}

function normalizeParentLevel(level, parentStack) {
  let normalized = level;
  while (normalized > 0 && !parentStack[normalized - 1]) {
    normalized -= 1;
  }
  return normalized;
}

function formatTaskLine(task, depth) {
  const check = task.completed ? "x" : " ";
  const indent = " ".repeat(depth * INDENT_WIDTH);
  let line = `${indent}- [${check}] ${task.text}`;

  if (task.dueDate) {
    line += ` (due: ${task.dueDate})`;
  }
  if (task.recurring) {
    line += ` (${task.recurring})`;
  }

  return line;
}

function orderTasksForSerialization(tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map();

  for (const task of tasks) {
    const parentId =
      task.parentId && task.parentId !== task.id && tasksById.has(task.parentId)
        ? task.parentId
        : null;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(task);
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  const walk = (task, depth) => {
    if (visited.has(task.id) || visiting.has(task.id)) return;
    visiting.add(task.id);
    ordered.push({ task, depth });
    visited.add(task.id);

    for (const child of childrenByParent.get(task.id) || []) {
      walk(child, depth + 1);
    }

    visiting.delete(task.id);
  };

  for (const root of childrenByParent.get(null) || []) {
    walk(root, 0);
  }

  // Safety for malformed parent chains/cycles.
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      walk(task, 0);
    }
  }

  return ordered;
}

/**
 * Parse a markdown string into structured sections/tasks.
 * @param {string} markdown
 * @returns {{ sections: Array<{ name: string, tasks: Array }> }}
 */
export function parse(markdown) {
  if (!markdown || !markdown.trim()) {
    return { sections: [] };
  }

  const lines = markdown.split("\n");
  const sections = [];
  let currentSection = null;
  const parentStack = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Section header: ## Name
    const headingMatch = trimmed.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1].trim(), tasks: [] };
      sections.push(currentSection);
      parentStack.length = 0;
      continue;
    }

    // Task line: optional indentation + - [ ] or - [x]
    const taskMatch = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (!currentSection) {
        currentSection = { name: DEFAULT_SECTION, tasks: [] };
        sections.push(currentSection);
        parentStack.length = 0;
      }

      const completed = taskMatch[2].toLowerCase() === "x";
      let text = taskMatch[3].trim();
      let dueDate = null;
      let recurring = null;

      // Extract due date: (due: YYYY-MM-DD)
      const dueMatch = text.match(/\(due:\s*(\d{4}-\d{2}-\d{2})\)/);
      if (dueMatch) {
        dueDate = dueMatch[1];
        text = text.replace(dueMatch[0], "").trim();
      }

      // Extract recurring: (daily) or (weekly)
      const recurringMatch = text.match(/\((daily|weekly)\)/);
      if (recurringMatch) {
        recurring = recurringMatch[1];
        text = text.replace(recurringMatch[0], "").trim();
      }

      const level = normalizeParentLevel(
        getIndentLevel(taskMatch[1]),
        parentStack
      );
      const id = crypto.randomUUID();
      const parentId = level > 0 ? parentStack[level - 1] : null;

      currentSection.tasks.push({
        id,
        text,
        completed,
        parentId,
        dueDate,
        recurring,
        completedAt: completed ? new Date().toISOString() : null,
      });
      parentStack[level] = id;
      parentStack.length = level + 1;
    }
    // Skip other lines (blank lines, comments, etc.)
  }

  return { sections };
}

/**
 * Serialize structured sections/tasks back to markdown.
 * @param {Array<{ name: string, tasks: Array }>} sections
 * @returns {string}
 */
export function serialize(sections) {
  const parts = [];

  for (const section of sections) {
    parts.push(`## ${section.name}`);

    for (const { task, depth } of orderTasksForSerialization(section.tasks || [])) {
      parts.push(formatTaskLine(task, depth));
    }

    parts.push(""); // blank line between sections
  }

  return parts.join("\n").trim() + "\n";
}

/**
 * Flatten sections into a single tasks array (with section info).
 * @param {{ sections: Array }} parsed
 * @returns {Array}
 */
export function flattenTasks(parsed) {
  const tasks = [];
  for (const section of parsed.sections) {
    for (const task of section.tasks) {
      tasks.push({ ...task, section: section.name });
    }
  }
  return tasks;
}

/**
 * Rebuild sections from a flat tasks array.
 * @param {Array} tasks - tasks with .section property
 * @returns {Array<{ name: string, tasks: Array }>}
 */
export function groupBySections(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const sectionName = task.section || DEFAULT_SECTION;
    if (!map.has(sectionName)) {
      map.set(sectionName, []);
    }
    map.get(sectionName).push(task);
  }
  return Array.from(map.entries()).map(([name, tasks]) => ({ name, tasks }));
}
