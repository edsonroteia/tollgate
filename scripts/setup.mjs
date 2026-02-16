#!/usr/bin/env node

/**
 * Tollgate Setup Script
 *
 * - Prompts for markdown file path
 * - Writes ~/.tollgate/config.json
 * - Installs Chrome native messaging host manifest
 * - Copies host scripts to ~/.tollgate/native-host/
 */

import { createInterface } from "readline";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = join(homedir(), ".tollgate");
const HOST_DIR = join(CONFIG_DIR, "native-host");
const HOST_NAME = "com.tollgate.host";

// Chrome native messaging host manifest directory (macOS)
const CHROME_NMH_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts"
);

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((res) => {
    rl.question(question, (answer) => res(answer.trim()));
  });
}

async function main() {
  console.log("\n  Tollgate Setup\n");

  // 1. Get markdown file path
  let mdPath = await ask("  Path to your markdown task file: ");
  mdPath = mdPath.replace(/^['"]|['"]$/g, ""); // strip surrounding quotes
  mdPath = mdPath.replace(/\\ /g, " ");        // unescape spaces
  mdPath = mdPath.replace(/^~/, homedir());
  mdPath = resolve(mdPath);
  console.log("  Resolved path:", mdPath);

  if (!existsSync(mdPath)) {
    const create = await ask("  File doesn't exist. Create it? (y/n) ");
    if (create.toLowerCase() === "y") {
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, "## Tasks\n- [ ] Your first task\n", "utf8");
      console.log("  Created:", mdPath);
    } else {
      console.log("  Aborted.");
      rl.close();
      process.exit(1);
    }
  }

  // 2. Write config
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({ markdownPath: mdPath }, null, 2) + "\n",
    "utf8"
  );
  console.log("  Config written:", join(CONFIG_DIR, "config.json"));

  // 3. Copy host scripts and generate wrapper with correct node path
  mkdirSync(HOST_DIR, { recursive: true });
  copyFileSync(
    join(__dirname, "native-host.mjs"),
    join(HOST_DIR, "native-host.mjs")
  );

  // Write wrapper with the node path from this process so Chrome can find it
  const nodePath = dirname(process.execPath);
  const wrapper = `#!/bin/bash
# Wrapper script for Tollgate native messaging host.
# Chrome doesn't load shell profiles, so we set PATH explicitly.
export PATH="${nodePath}:/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/native-host.mjs"
`;
  writeFileSync(join(HOST_DIR, "native-host-wrapper.sh"), wrapper, "utf8");
  chmodSync(join(HOST_DIR, "native-host-wrapper.sh"), 0o755);
  console.log("  Host scripts installed:", HOST_DIR);

  // 4. Get extension ID for native messaging
  console.log("\n  Find your extension ID at chrome://extensions (with Developer mode on)");
  const extId = await ask("  Chrome extension ID: ");

  if (!extId || extId.length < 10) {
    console.log("  Invalid extension ID. Aborted.");
    rl.close();
    process.exit(1);
  }

  // 5. Install Chrome native messaging host manifest
  mkdirSync(CHROME_NMH_DIR, { recursive: true });

  const manifest = {
    name: HOST_NAME,
    description: "Tollgate native messaging host",
    path: join(HOST_DIR, "native-host-wrapper.sh"),
    type: "stdio",
    allowed_origins: [
      `chrome-extension://${extId}/`,
    ],
  };

  const manifestPath = join(CHROME_NMH_DIR, HOST_NAME + ".json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("  NMH manifest installed:", manifestPath);

  console.log("\n  Setup complete! Restart Chrome to activate native messaging.\n");
  rl.close();
}

main();
