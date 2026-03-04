#!/usr/bin/env node
/**
 * Bash Guard Hook — PreToolUse enforcement for Bash tool.
 *
 * Closes the gap: agents using Bash (cp, rm, mv) can bypass Edit/Write
 * hooks and overwrite deployed hooks or evidence files.
 *
 * Behavior:
 *   - Logs ALL Bash commands to .rl4/.internal/bash_commands.jsonl
 *   - Flags commands that touch protected paths (.rl4/, dist/hooks/)
 *   - Mode OBSERVE (default): log only
 *   - Mode ENFORCE: deny commands that write to protected paths
 *
 * Safety Manifesto:
 *   #1 FAIL SOFT — exit 0 on ANY error
 *   #2 FAST — no HTTP calls, just regex + local append (~5ms)
 *   #3 NEVER block reads (cat, ls, grep, head, tail)
 */
import * as fs from "fs";
import * as path from "path";
import { lockedAppend } from "../utils/fs_lock.js";
// ── Config ──────────────────────────────────────────────────────────────────
const MODE = (process.env.RL4_BASH_GUARD || "observe").toLowerCase();
// Write commands that could modify protected files
const WRITE_PATTERNS = /\b(cp|mv|rm|rsync|install|ln|tee|dd)\b/;
// Protected path patterns — these should only be written via MCP/hooks
const PROTECTED_PATHS = [
    /\.rl4\/evidence\//, // Single-writer: only MCP daemon writes here
    /\.rl4\/.internal\//, // Internal state files
    /dist\/hooks\//, // Deployed hooks (prevent overwrite)
    /mcp-server\/dist\//, // MCP server dist (prevent stale overwrite)
];
// Read-only commands — never block these
const READ_ONLY = /^\s*(cat|head|tail|less|more|grep|rg|find|ls|wc|file|stat|du|df|echo|printf|which|type|env|printenv|pwd|date|whoami|id|uname)\b/;
// ── Helpers ─────────────────────────────────────────────────────────────────
function findWorkspaceRoot(cwd) {
    let dir = cwd || process.cwd();
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, ".rl4")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return cwd || process.cwd();
}
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { data += chunk; });
        process.stdin.on("end", () => resolve(data));
        setTimeout(() => resolve(data), 1500);
    });
}
function outputDecision(decision, reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    }));
}
// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    var _a;
    const stdinRaw = await readStdin();
    let input;
    try {
        input = JSON.parse(stdinRaw);
    }
    catch {
        process.exit(0);
        return;
    }
    const command = ((_a = input.tool_input) === null || _a === void 0 ? void 0 : _a.command) || "";
    if (!command) {
        process.exit(0);
        return;
    }
    const root = findWorkspaceRoot(input.cwd);
    // Check command characteristics
    const isReadOnly = READ_ONLY.test(command);
    const isWriteOp = WRITE_PATTERNS.test(command);
    const touchedProtected = PROTECTED_PATHS.filter((p) => p.test(command));
    const isFlagged = isWriteOp && touchedProtected.length > 0;
    // Log ALL commands — real-time audit trail
    try {
        const logDir = path.join(root, ".rl4", ".internal");
        if (!fs.existsSync(logDir))
            fs.mkdirSync(logDir, { recursive: true });
        lockedAppend(path.join(logDir, "bash_commands.jsonl"), JSON.stringify({
            t: new Date().toISOString(),
            session_id: input.session_id || "unknown",
            command: command.slice(0, 500),
            is_read_only: isReadOnly,
            is_write: isWriteOp,
            flagged: isFlagged,
            protected_paths: touchedProtected.map((p) => p.source),
        }));
    }
    catch { /* non-blocking */ }
    // Enforcement
    if (isFlagged && MODE === "enforce") {
        outputDecision("deny", [
            `[RL4 Bash Guard] BLOCKED: This command writes to protected RL4 paths.`,
            `Protected paths matched: ${touchedProtected.map((p) => p.source).join(", ")}`,
            `Command: ${command.slice(0, 200)}`,
            ``,
            `Use MCP tools (suggest_edit/apply_edit) or the MCP HTTP server (/ingest) instead.`,
            `If this is a legitimate deploy, use the build+deploy script from the source dir.`,
        ].join("\n"));
        process.exit(2);
        return;
    }
    if (isFlagged && MODE === "observe") {
        // Soft warning — allow but inform
        outputDecision("allow", `[RL4 Bash Guard] WARNING: This command touches protected RL4 paths (${touchedProtected.map((p) => p.source).join(", ")}). Consider using MCP tools instead.`);
        process.exit(0);
        return;
    }
    // Normal write op, not touching protected paths → allow silently
    process.exit(0);
}
main().catch(() => process.exit(0));
