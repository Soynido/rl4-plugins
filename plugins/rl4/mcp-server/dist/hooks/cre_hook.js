#!/usr/bin/env node
/**
 * CRE Hook for Claude Code — PreToolUse / PostToolUse enforcement.
 *
 * Safety Manifesto:
 *   #1 FAIL SOFT — global try/catch, log errors, exit 0 on ANY internal failure
 *   #2 PARSE JSON — stdin only, never trust ENV
 *   #5 SINGLE WRITER — deny native Write when suggest_edit cache exists (hard mode)
 *   #7 CACHE TTL — 30s, matches apply_edit
 *   #10 IDEMPOTENT — no side effects on repeated calls
 *
 * Claude Code hooks API:
 *   - stdin: JSON with { session_id, cwd, hook_event_name, tool_name, tool_input, ... }
 *   - stdout: JSON { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *   - exit 0 = allow, exit 2 = block
 */
import * as fs from "fs";
import * as path from "path";
// ── Config ──────────────────────────────────────────────────────────────────
const ENFORCEMENT = process.env.RL4_CRE_ENFORCEMENT === "hard" ? "hard" : "soft";
const SUGGESTION_CACHE = ".rl4/.internal/cre_last_suggestion.json";
const ERROR_LOG = ".rl4/.internal/cre_hook_errors.jsonl";
const CACHE_TTL_MS = 30000; // 30s — matches apply_edit TTL
// ── Error Logger (Manifesto #1: fail soft) ──────────────────────────────────
function logError(root, error, context) {
    try {
        const logPath = path.join(root, ERROR_LOG);
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify({
            t: new Date().toISOString(),
            error,
            context,
        }) + "\n");
    }
    catch {
        // Last resort: can't even log. Silently continue.
    }
}
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
        setTimeout(() => resolve(data), 3000);
    });
}
function readCachedSuggestion(root) {
    const cachePath = path.join(root, SUGGESTION_CACHE);
    try {
        if (!fs.existsSync(cachePath))
            return null;
        const raw = fs.readFileSync(cachePath, "utf-8");
        const parsed = JSON.parse(raw);
        const age = Date.now() - new Date(parsed.timestamp).getTime();
        if (age > CACHE_TTL_MS)
            return null; // Manifesto #7: 30s TTL
        return parsed;
    }
    catch {
        return null;
    }
}
function extractFilePath(input) {
    var _a, _b;
    return (_b = (_a = input.tool_input) === null || _a === void 0 ? void 0 : _a.file_path) !== null && _b !== void 0 ? _b : null;
}
function normalizeRelPath(filePath, root) {
    if (path.isAbsolute(filePath)) {
        return path.relative(root, filePath);
    }
    return filePath;
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
// ── PreToolUse Handler ──────────────────────────────────────────────────────
async function handlePreTool() {
    const stdinRaw = await readStdin();
    let input;
    try {
        input = JSON.parse(stdinRaw);
    }
    catch {
        process.exit(0); // Can't parse → allow silently
        return;
    }
    const filePath = extractFilePath(input);
    if (!filePath) {
        process.exit(0); // No file path → not a file write
        return;
    }
    const root = findWorkspaceRoot(input.cwd);
    const relPath = normalizeRelPath(filePath, root);
    const cached = readCachedSuggestion(root);
    if (cached && cached.file === relPath) {
        // Manifesto #5: SINGLE WRITER — suggest_edit was called, agent should use apply_edit not native Write
        if (ENFORCEMENT === "hard") {
            outputDecision("deny", `CRE: suggest_edit already analyzed "${relPath}". Use apply_edit (MCP tool) to write this file, not native Write/Edit. ` +
                `apply_edit logs the intervention for CRE learning. Native writes bypass the loop.`);
            process.exit(2);
            return;
        }
        // Soft: allow but output lessons as feedback
        if (cached.lessons.length > 0) {
            const lessonLines = cached.lessons
                .map((l, i) => `${i + 1}. [${l.type}] ${l.text} (score: ${l.score.toFixed(3)}, ${l.source})`)
                .join("\n");
            outputDecision("allow", `CRE lessons for ${relPath}:\n${lessonLines}\n` +
                `Tip: use apply_edit (MCP tool) instead of native Write to enable CRE learning.`);
        }
        process.exit(0);
        return;
    }
    // No cache — file edited without suggest_edit
    const reason = `CRE: "${relPath}" was not analyzed with suggest_edit before editing. ` +
        `Use suggest_edit("${relPath}") first, then apply_edit to write. ` +
        `Without this flow, the edit is invisible to the causal learning loop.`;
    if (ENFORCEMENT === "hard") {
        outputDecision("deny", reason + " Write blocked.");
        process.exit(2);
        return;
    }
    // Soft: warn but allow
    outputDecision("allow", reason);
    process.exit(0);
}
// ── PostToolUse Handler ─────────────────────────────────────────────────────
async function handlePostTool() {
    var _a, _b;
    const stdinRaw = await readStdin();
    let input;
    try {
        input = JSON.parse(stdinRaw);
    }
    catch {
        process.exit(0);
        return;
    }
    const filePath = extractFilePath(input);
    if (!filePath) {
        process.exit(0);
        return;
    }
    const root = findWorkspaceRoot(input.cwd);
    const relPath = normalizeRelPath(filePath, root);
    // Log every write for coverage tracking
    const logPath = path.join(root, ".rl4", ".internal", "hook_writes.jsonl");
    const logDir = path.dirname(logPath);
    try {
        if (!fs.existsSync(logDir))
            fs.mkdirSync(logDir, { recursive: true });
        const cached = readCachedSuggestion(root);
        const entry = {
            timestamp: new Date().toISOString(),
            file: relPath,
            tool: (_a = input.tool_name) !== null && _a !== void 0 ? _a : "unknown",
            had_suggestion: (cached === null || cached === void 0 ? void 0 : cached.file) === relPath,
            session_id: (_b = input.session_id) !== null && _b !== void 0 ? _b : null,
        };
        fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    }
    catch {
        // Non-blocking
    }
    process.exit(0);
}
// ── Main (Manifesto #1: fail soft, never brick) ─────────────────────────────
const mode = process.argv[2];
async function run() {
    try {
        if (mode === "pretool") {
            await handlePreTool();
        }
        else if (mode === "posttool") {
            await handlePostTool();
        }
        else {
            process.stderr.write("Usage: cre_hook.mjs pretool|posttool\n");
            process.exit(1);
        }
    }
    catch (err) {
        // Manifesto #1: on ANY error, log and allow
        const root = findWorkspaceRoot();
        logError(root, String(err), `mode=${mode}`);
        process.exit(0); // ALWAYS allow on error — never brick the IDE
    }
}
run();
