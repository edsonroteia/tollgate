#!/usr/bin/env node

/**
 * Tollgate Native Messaging Host
 *
 * Chrome launches this process via native messaging.
 * It reads/writes a markdown task file and syncs with the extension
 * using stdin/stdout with length-prefixed JSON messages.
 */

import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".tollgate");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { markdownPath: "" };
  }
}

// ── Markdown parser (mirrors chrome-extension/markdown.js) ──────────

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

  if (task.dueDate) line += ` (due: ${task.dueDate})`;
  if (task.recurring) line += ` (${task.recurring})`;

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

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      walk(task, 0);
    }
  }

  return ordered;
}

function parse(markdown) {
  if (!markdown || !markdown.trim()) return { sections: [] };

  const lines = markdown.split("\n");
  const sections = [];
  let currentSection = null;
  const parentStack = [];

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = trimmed.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1].trim(), tasks: [] };
      sections.push(currentSection);
      parentStack.length = 0;
      continue;
    }

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

      const dueMatch = text.match(/\(due:\s*(\d{4}-\d{2}-\d{2})\)/);
      if (dueMatch) {
        dueDate = dueMatch[1];
        text = text.replace(dueMatch[0], "").trim();
      }

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
  }

  return { sections };
}

function serialize(sections) {
  const parts = [];
  for (const section of sections) {
    parts.push(`## ${section.name}`);
    for (const { task, depth } of orderTasksForSerialization(section.tasks || [])) {
      parts.push(formatTaskLine(task, depth));
    }
    parts.push("");
  }
  return parts.join("\n").trim() + "\n";
}

function flattenTasks(parsed) {
  const tasks = [];
  for (const section of parsed.sections) {
    for (const task of section.tasks) {
      tasks.push({ ...task, section: section.name });
    }
  }
  return tasks;
}

function groupBySections(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const name = task.section || DEFAULT_SECTION;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(task);
  }
  return Array.from(map.entries()).map(([name, tasks]) => ({ name, tasks }));
}

// ── Native messaging I/O ────────────────────────────────────────────

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let bytesRead = 0;

    const readHeader = () => {
      const chunk = process.stdin.read(4 - bytesRead);
      if (!chunk) {
        process.stdin.once("readable", readHeader);
        return;
      }
      chunk.copy(header, bytesRead);
      bytesRead += chunk.length;

      if (bytesRead < 4) {
        process.stdin.once("readable", readHeader);
        return;
      }

      const len = header.readUInt32LE(0);
      if (len === 0) {
        resolve(null);
        return;
      }

      let body = "";
      let bodyRead = 0;

      const readBody = () => {
        const data = process.stdin.read(len - bodyRead);
        if (!data) {
          process.stdin.once("readable", readBody);
          return;
        }
        body += data.toString("utf8");
        bodyRead += data.length;

        if (bodyRead < len) {
          process.stdin.once("readable", readBody);
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      };

      readBody();
    };

    readHeader();
  });
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

// ── File operations ─────────────────────────────────────────────────

function readTasksFromFile(mdPath) {
  try {
    const content = readFileSync(mdPath, "utf8");
    const parsed = parse(content);
    return flattenTasks(parsed);
  } catch {
    return [];
  }
}

function writeTasksToFile(mdPath, tasks) {
  const sections = groupBySections(tasks);
  const md = serialize(sections);
  writeFileSync(mdPath, md, "utf8");
}

// ── Main loop ───────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const mdPath = config.markdownPath;

  // Send config to extension so it can display the markdown path
  sendMessage({ type: "config", config: { markdownPath: mdPath } });

  if (mdPath && existsSync(mdPath)) {
    // Send initial tasks to extension
    const tasks = readTasksFromFile(mdPath);
    sendMessage({ type: "tasks", tasks });

    // Watch for external file changes
    watchFile(mdPath, { interval: 2000 }, () => {
      const updated = readTasksFromFile(mdPath);
      sendMessage({ type: "tasks", tasks: updated });
    });
  }

  // Listen for messages from extension
  while (true) {
    try {
      const msg = await readMessage();
      if (!msg) break;

      if (msg.type === "tasks" && mdPath) {
        writeTasksToFile(mdPath, msg.tasks);
      } else if (msg.type === "read" && mdPath) {
        const tasks = readTasksFromFile(mdPath);
        sendMessage({ type: "tasks", tasks });
      }
    } catch {
      break;
    }
  }

  if (mdPath) unwatchFile(mdPath);
}

main();
