#!/usr/bin/env node
/**
 * Agent Gate Hook — PreToolUse enforcement for Agent tool.
 *
 * When Claude Code spawns a sub-agent (Explore, Plan, etc.), this hook
 * checks if the sub-agent prompt contains the RL4 Context Snapshot.
 * If not, it can DENY the call and force the main agent to re-submit
 * with the snapshot included.
 *
 * Modes:
 *   OBSERVE (default) — always allow, log compliance
 *   ENFORCE — deny if snapshot missing (set RL4_AGENT_GATE=enforce)
 *
 * Safety Manifesto:
 *   #1 FAIL SOFT — global try/catch, exit 0 on ANY failure
 *   #2 ANTI-LOOP — max 3 denials per session, then allow with warning
 *   #3 SERVER DOWN — allow without check
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { lockedAppend } from "../utils/fs_lock.js";
// ── Config ──────────────────────────────────────────────────────────────────
const GATEKEEPER_PORT = parseInt(process.env.RL4_HTTP_PORT || "17340", 10);
const GATEKEEPER_HOST = "127.0.0.1";
const HTTP_TIMEOUT_MS = 2000;
const MODE = (process.env.RL4_AGENT_GATE || "enforce").toLowerCase(); // "observe" | "enforce"
const MAX_DENIALS_PER_SESSION = 3;
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
function outputDecision(decision, reason) {
    const output = {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    };
    process.stdout.write(JSON.stringify(output));
}
/** Extract all string values from tool_input for marker search. */
function extractAllText(obj) {
    return Object.values(obj)
        .filter((v) => typeof v === "string")
        .join(" ");
}
// ── Denial Counter (anti-loop) ──────────────────────────────────────────────
const DENIAL_COUNT_DIR = path.join(process.env.TMPDIR || "/tmp", "rl4-agent-gate");
function getDenialCount(sessionId) {
    try {
        const file = path.join(DENIAL_COUNT_DIR, `${sessionId}.count`);
        if (fs.existsSync(file))
            return parseInt(fs.readFileSync(file, "utf-8"), 10) || 0;
    }
    catch { /* fail soft */ }
    return 0;
}
function incrementDenialCount(sessionId) {
    try {
        if (!fs.existsSync(DENIAL_COUNT_DIR))
            fs.mkdirSync(DENIAL_COUNT_DIR, { recursive: true });
        const file = path.join(DENIAL_COUNT_DIR, `${sessionId}.count`);
        const current = getDenialCount(sessionId);
        fs.writeFileSync(file, String(current + 1));
    }
    catch { /* fail soft */ }
}
// ── HTTP Client — fetch context for injection ───────────────────────────────
function fetchContext(prompt, root) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ prompt: prompt.slice(0, 2000), root });
        const req = http.request({
            hostname: GATEKEEPER_HOST,
            port: GATEKEEPER_PORT,
            path: "/context-for-prompt",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
            timeout: HTTP_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                    resolve(data.context || null);
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
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
    const toolInput = input.tool_input || {};
    const allText = extractAllText(toolInput);
    const sessionId = input.session_id || "unknown";
    const hasSnapshot = allText.includes("--- RL4 Context Snapshot ---");
    const hasAvoid = allText.includes("[RL4 AVOID]");
    // Log compliance (always, regardless of mode)
    try {
        const logDir = path.join(root, ".rl4", ".internal");
        if (!fs.existsSync(logDir))
            fs.mkdirSync(logDir, { recursive: true });
        lockedAppend(path.join(logDir, "agent_gate.jsonl"), JSON.stringify({
            t: new Date().toISOString(),
            session_id: sessionId,
            mode: MODE,
            has_snapshot: hasSnapshot,
            has_avoid: hasAvoid,
            tool_input_keys: Object.keys(toolInput),
            prompt_preview: allText.slice(0, 200),
        }));
    }
    catch { /* non-blocking */ }
    // If snapshot present → always allow
    if (hasSnapshot || hasAvoid) {
        process.exit(0);
        return;
    }
    // Snapshot missing — behavior depends on mode
    if (MODE !== "enforce") {
        // OBSERVE mode: allow silently (data already logged above)
        process.exit(0);
        return;
    }
    // ENFORCE mode: check anti-loop counter
    const denials = getDenialCount(sessionId);
    if (denials >= MAX_DENIALS_PER_SESSION) {
        // Safety valve: allow after too many denials to prevent deadlock
        outputDecision("allow", "[RL4 Agent Gate] WARNING: Allowing without context after 3 failed attempts. Include the RL4 Context Snapshot in Agent prompts.");
        process.exit(0);
        return;
    }
    // Fetch context to include in the denial reason
    const promptText = toolInput.prompt || toolInput.task || "";
    const context = await fetchContext(promptText, root);
    incrementDenialCount(sessionId);
    const reason = [
        "[RL4 Agent Gate] BLOCKED: Sub-agent prompt is missing the RL4 Context Snapshot.",
        "You MUST include the '--- RL4 Context Snapshot ---' block from your additionalContext in the Agent tool prompt.",
        "Copy it VERBATIM into the sub-agent task description, then retry.",
        "",
        context ? `Here is the context to include:\n\n--- RL4 Context Snapshot ---\n${context}\n--- END RL4 Context Snapshot ---` : "",
    ].filter(Boolean).join("\n");
    outputDecision("deny", reason);
    process.exit(2);
}
// Manifesto #1: fail soft
main().catch(() => process.exit(0));
