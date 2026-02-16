/**
 * Markdown task list parser/serializer.
 *
 * Format:
 *   ## Section Name
 *   - [ ] Task text
 *   - [x] Completed task (due: 2026-02-17)
 *   - [ ] Recurring task (daily)
 */

const DEFAULT_SECTION = "Tasks";

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

  for (const line of lines) {
    const trimmed = line.trim();

    // Section header: ## Name
    const headingMatch = trimmed.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1].trim(), tasks: [] };
      sections.push(currentSection);
      continue;
    }

    // Task line: - [ ] or - [x]
    const taskMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (!currentSection) {
        currentSection = { name: DEFAULT_SECTION, tasks: [] };
        sections.push(currentSection);
      }

      const completed = taskMatch[1].toLowerCase() === "x";
      let text = taskMatch[2].trim();
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

      currentSection.tasks.push({
        id: crypto.randomUUID(),
        text,
        completed,
        dueDate,
        recurring,
        completedAt: completed ? new Date().toISOString() : null,
      });
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

    for (const task of section.tasks) {
      const check = task.completed ? "x" : " ";
      let line = `- [${check}] ${task.text}`;

      if (task.dueDate) {
        line += ` (due: ${task.dueDate})`;
      }
      if (task.recurring) {
        line += ` (${task.recurring})`;
      }

      parts.push(line);
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
