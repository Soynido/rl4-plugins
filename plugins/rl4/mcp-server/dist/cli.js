#!/usr/bin/env node
/**
 * RL4 CLI — Standalone entry point for context-for-prompt.
 *
 * Used by rl4-prompt-capture.sh as fallback when the Cursor HTTP daemon
 * (port 17340) is not running. Provides the same 6-part context
 * (file-specific + AVOID + RAG + hot files + decisions + timeline)
 * without requiring the HTTP server.
 *
 * Usage:
 *   node cli.js context-for-prompt <workspace_root> [prompt_text]
 *
 * Read-only — respects SWA (no writes to .rl4/evidence/).
 */
import { handleContextForPrompt } from "./http_server.js";
const [, , command, ...args] = process.argv;
if (command === "context-for-prompt") {
    const root = args[0] || process.cwd();
    const prompt = args.slice(1).join(" ") || "";
    try {
        const result = handleContextForPrompt(root, prompt);
        process.stdout.write(result.context);
    }
    catch (err) {
        // Fail soft — output nothing rather than crashing
        process.stderr.write(`RL4 CLI error: ${err}\n`);
        process.exit(1);
    }
}
else {
    process.stderr.write(`Unknown command: ${command}\nUsage: node cli.js context-for-prompt <root> [prompt]\n`);
    process.exit(1);
}
