#!/usr/bin/env node
/**
 * Agent Compliance Hook — PostToolUse logger for Agent tool.
 *
 * Purpose:
 *   1. Discover the exact tool_input schema for Claude Code's Agent tool
 *   2. Log whether sub-agent prompts contain RL4 context markers
 *   3. Build compliance metrics over time
 *
 * Safety Manifesto:
 *   #1 FAIL SOFT — global try/catch, exit 0 on ANY failure
 *   #2 PASSIVE — never blocks, never modifies, just logs
 *   #3 FAST — no HTTP calls, just local JSONL append
 */
import * as fs from "fs";
import * as path from "path";
import { lockedAppend } from "../utils/fs_lock.js";
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
        setTimeout(() => resolve(data), 2000);
    });
}
/** Extract text from all string fields of tool_input for marker search. */
function extractAllText(obj) {
    return Object.values(obj)
        .filter((v) => typeof v === "string")
        .join(" ");
}
// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const stdinRaw = await readStdin();
    let input;
    try {
        input = JSON.parse(stdinRaw);
    }
    catch {
        process.exit(0);
        return;
    }
    const root = findWorkspaceRoot(input.cwd);
    const logDir = path.join(root, ".rl4", ".internal");
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    const toolInput = input.tool_input || {};
    const allText = extractAllText(toolInput);
    const hasSnapshot = allText.includes("--- RL4 Context Snapshot ---");
    const hasAvoid = allText.includes("[RL4 AVOID]");
    const hasEndMarker = allText.includes("--- END RL4 Context Snapshot ---");
    // Extract a preview from the most likely prompt field
    const promptText = (toolInput.prompt ||
        toolInput.task ||
        toolInput.description ||
        "").slice(0, 300);
    const entry = {
        t: new Date().toISOString(),
        session_id: input.session_id || "unknown",
        tool_name: input.tool_name || "Agent",
        tool_input_keys: Object.keys(toolInput),
        has_snapshot: hasSnapshot,
        has_end_marker: hasEndMarker,
        has_avoid: hasAvoid,
        compliance_score: hasSnapshot && hasEndMarker ? 1.0 : hasAvoid ? 0.5 : 0.0,
        prompt_length: allText.length,
        prompt_preview: promptText,
    };
    const logPath = path.join(logDir, "agent_compliance.jsonl");
    lockedAppend(logPath, JSON.stringify(entry));
    // Always allow — pure observation
    process.exit(0);
}
// Manifesto #1: fail soft
main().catch(() => process.exit(0));
