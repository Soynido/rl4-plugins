#!/usr/bin/env node
/**
 * RL4 MCP Server Launcher
 * Auto-installs dependencies on first run, then starts the MCP server.
 */
import { existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(__dirname, "node_modules");

if (!existsSync(nodeModules)) {
  console.error("[RL4] First run — installing dependencies...");
  try {
    execSync("npm install --omit=dev", { cwd: __dirname, stdio: "inherit" });
    console.error("[RL4] Dependencies installed.");
  } catch (e) {
    console.error("[RL4] Failed to install dependencies. Run manually:");
    console.error(`  cd ${__dirname} && npm install`);
    process.exit(1);
  }
}

// Start the actual MCP server
await import("./dist/index.js");
