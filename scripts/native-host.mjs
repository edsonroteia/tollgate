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

function parse(markdown) {
  if (!markdown || !markdown.trim()) return { sections: [] };

  const lines = markdown.split("\n");
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = trimmed.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1].trim(), tasks: [] };
      sections.push(currentSection);
      continue;
    }

    const taskMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (!currentSection) {
        currentSection = { name: "Tasks", tasks: [] };
        sections.push(currentSection);
      }

      const completed = taskMatch[1].toLowerCase() === "x";
      let text = taskMatch[2].trim();
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

      currentSection.tasks.push({
        id: crypto.randomUUID(),
        text,
        completed,
        dueDate,
        recurring,
        completedAt: completed ? new Date().toISOString() : null,
      });
    }
  }

  return { sections };
}

function serialize(sections) {
  const parts = [];
  for (const section of sections) {
    parts.push(`## ${section.name}`);
    for (const task of section.tasks) {
      const check = task.completed ? "x" : " ";
      let line = `- [${check}] ${task.text}`;
      if (task.dueDate) line += ` (due: ${task.dueDate})`;
      if (task.recurring) line += ` (${task.recurring})`;
      parts.push(line);
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
    const name = task.section || "Tasks";
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
