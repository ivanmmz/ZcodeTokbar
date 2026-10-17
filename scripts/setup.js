#!/usr/bin/env node
"use strict";
/**
 * Add or remove the token bar SessionStart hook in ~/.zcode/cli/config.json.
 *
 *   node setup.js add      ensure hooks.enabled and install the SessionStart hook
 *   node setup.js remove   drop every hook entry that references token_bar_cdp.js
 *
 * Idempotent: existing entries that point at token_bar_cdp.js are replaced,
 * every other hook is left untouched. A one-time backup is kept next to the
 * config as config.json.token-bar.bak.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG = path.join(os.homedir(), ".zcode", "cli", "config.json");
const SCRIPT = path.join(__dirname, "token_bar_cdp.js");
const MARKER = "token_bar_cdp.js";

const action = (process.argv[2] || "add").toLowerCase();

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function isOurs(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && JSON.stringify(h).includes(MARKER));
}

function main() {
  let cfg = readConfig();
  if (typeof cfg !== "object" || cfg === null) cfg = {};

  // one-time backup
  const bak = CONFIG + ".token-bar.bak";
  try {
    if (fs.existsSync(CONFIG) && !fs.existsSync(bak)) fs.copyFileSync(CONFIG, bak);
  } catch {}

  cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};
  cfg.hooks.events = cfg.hooks.events && typeof cfg.hooks.events === "object" ? cfg.hooks.events : {};
  const list = Array.isArray(cfg.hooks.events.SessionStart) ? cfg.hooks.events.SessionStart : [];
  const cleaned = list.filter((e) => !isOurs(e));

  if (action === "remove") {
    if (cleaned.length) cfg.hooks.events.SessionStart = cleaned;
    else delete cfg.hooks.events.SessionStart;
    if (!Object.keys(cfg.hooks.events).length) delete cfg.hooks.events;
  } else {
    cfg.hooks.enabled = true;
    cleaned.push({
      hooks: [
        {
          type: "process",
          command: process.execPath,
          args: [SCRIPT, "--spawn"],
          timeoutMs: 15000,
        },
      ],
    });
    cfg.hooks.events.SessionStart = cleaned;
  }

  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`config.json patched (${action}): ${CONFIG}`);
}

main();
