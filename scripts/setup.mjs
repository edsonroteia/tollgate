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

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("\n  Tollgate Setup\n");

  // 1. Get markdown file path
  let mdPath = await ask("  Path to your markdown task file: ");
  mdPath = resolve(mdPath.replace(/^~/, homedir()));

  if (!existsSync(mdPath)) {
    const create = await ask(`  File doesn't exist. Create it? (y/n) `);
    if (create.toLowerCase() === "y") {
      writeFileSync(mdPath, "## Tasks\n- [ ] Your first task\n", "utf8");
      console.log("  Created:", mdPath);
    } else {
      console.log("  Aborted.");
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

  // 3. Copy host scripts
  mkdirSync(HOST_DIR, { recursive: true });
  copyFileSync(
    join(__dirname, "native-host.mjs"),
    join(HOST_DIR, "native-host.mjs")
  );
  copyFileSync(
    join(__dirname, "native-host-wrapper.sh"),
    join(HOST_DIR, "native-host-wrapper.sh")
  );
  chmodSync(join(HOST_DIR, "native-host-wrapper.sh"), 0o755);
  console.log("  Host scripts installed:", HOST_DIR);

  // 4. Install Chrome native messaging host manifest
  mkdirSync(CHROME_NMH_DIR, { recursive: true });

  const manifest = {
    name: HOST_NAME,
    description: "Tollgate native messaging host",
    path: join(HOST_DIR, "native-host-wrapper.sh"),
    type: "stdio",
    allowed_origins: [
      // The extension ID will be known after loading unpacked.
      // Use a wildcard-compatible pattern; user may need to update this.
      `chrome-extension://*/`,
    ],
  };

  const manifestPath = join(CHROME_NMH_DIR, HOST_NAME + ".json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("  NMH manifest installed:", manifestPath);

  console.log(
    "\n  Note: After loading the extension, update the allowed_origins"
  );
  console.log("  in the NMH manifest with your extension ID:");
  console.log(`  chrome-extension://<YOUR_EXTENSION_ID>/\n`);

  console.log("  Setup complete!\n");
}

main();
