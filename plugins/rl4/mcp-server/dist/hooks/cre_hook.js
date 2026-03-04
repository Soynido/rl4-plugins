#!/usr/bin/env node
/**
 * CRE Hook for Claude Code — PreToolUse / PostToolUse enforcement.
 *
 * Architecture:
 *   PreToolUse → POST http://127.0.0.1:17340/validate → CRE lessons injected into response
 *   PostToolUse → log the write for coverage tracking
 *
 * The HTTP server runs in-process with the MCP server (shared caches, zero overhead).
 * If the server is down, fail soft (allow the write, no lessons).
 *
 * Safety Manifesto:
 *   #1 FAIL SOFT — global try/catch, log errors, exit 0 on ANY internal failure
 *   #2 PARSE JSON — stdin only, never trust ENV
 *   #7 CACHE TTL — handled server-side now
 *   #10 IDEMPOTENT — no side effects on repeated calls
 *
 * Claude Code hooks API:
 *   - stdin: JSON with { session_id, cwd, hook_event_name, tool_name, tool_input, ... }
 *   - stdout: JSON { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *   - exit 0 = allow, exit 2 = block
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { lockedAppend, lockedWrite } from "../utils/fs_lock.js";
// ── Config ──────────────────────────────────────────────────────────────────
const GATEKEEPER_PORT = parseInt(process.env.RL4_HTTP_PORT || "17340", 10);
const GATEKEEPER_HOST = "127.0.0.1";
const ERROR_LOG = ".rl4/.internal/cre_hook_errors.jsonl";
const HTTP_TIMEOUT_MS = 3000; // 3s max for HTTP call — hooks have 10s budget
// ── Error Logger (Manifesto #1: fail soft) ──────────────────────────────────
function logError(root, error, context) {
    try {
        const logPath = path.join(root, ERROR_LOG);
        lockedAppend(logPath, JSON.stringify({
            t: new Date().toISOString(),
            error,
            context,
        }));
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
            // D1 fix: permissionDecisionReason for "allow" is shown to user but NOT Claude.
            // additionalContext is injected into Claude's context (v2.1.9+).
            ...(decision === "allow" && reason ? { additionalContext: reason } : {}),
        },
    };
    process.stdout.write(JSON.stringify(output));
}
function checkTrustStatus() {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: GATEKEEPER_HOST,
            port: GATEKEEPER_PORT,
            path: "/trust-status",
            method: "GET",
            timeout: 500, // Ultra-fast — no body, just a read
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null)); // Fail-open: server down → null → allow
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.end();
    });
}
// ── HTTP Client — call /validate on the gatekeeper ──────────────────────────
function callValidate(relPath, root, content) {
    return new Promise((resolve) => {
        const payload = { file: relPath, root };
        if (content)
            payload.content = content;
        const body = JSON.stringify(payload);
        const req = http.request({
            hostname: GATEKEEPER_HOST,
            port: GATEKEEPER_PORT,
            path: "/validate",
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
                    resolve(data);
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null)); // Server down → null → fail soft
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}
// ── PreToolUse Handler ──────────────────────────────────────────────────────
async function handlePreTool() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
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
    // Capture full suggested content (ground truth for what the LLM proposed)
    const ti = input.tool_input;
    const fullContent = (_b = (_a = ti === null || ti === void 0 ? void 0 : ti.new_string) !== null && _a !== void 0 ? _a : ti === null || ti === void 0 ? void 0 : ti.content) !== null && _b !== void 0 ? _b : undefined;
    const diffContent = fullContent === null || fullContent === void 0 ? void 0 : fullContent.slice(0, 500); // truncated for /validate context
    // Call gatekeeper AND trust-status in parallel (minimize latency)
    const [result, trustStatus] = await Promise.all([
        callValidate(relPath, root, diffContent),
        checkTrustStatus(),
    ]);
    if (!result) {
        // Server down or error → fail soft, allow write
        process.exit(0);
        return;
    }
    // ── Chain-of-Trust check ──
    const trustOk = (_c = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.trust_ok) !== null && _c !== void 0 ? _c : true; // null (server down) = fail-open
    if (!trustOk) {
        const TRUST_MODE = (process.env.RL4_TRUST_MODE || "observe").toLowerCase();
        const sessionId = (_d = input.session_id) !== null && _d !== void 0 ? _d : "unknown";
        // Log violation (always, regardless of mode)
        try {
            const trustLogDir = path.join(root, ".rl4", ".internal");
            if (!fs.existsSync(trustLogDir))
                fs.mkdirSync(trustLogDir, { recursive: true });
            lockedAppend(path.join(trustLogDir, "trust_violations.jsonl"), JSON.stringify({
                t: new Date().toISOString(),
                session_id: sessionId,
                file: relPath,
                age_seconds: (_e = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.age_seconds) !== null && _e !== void 0 ? _e : -1,
                threshold_seconds: (_f = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.threshold_seconds) !== null && _f !== void 0 ? _f : -1,
                mode: TRUST_MODE,
                tool_name: (_g = input.tool_name) !== null && _g !== void 0 ? _g : "unknown",
            }));
        }
        catch { /* non-blocking */ }
        if (TRUST_MODE === "enforce") {
            outputDecision("deny", [
                `[RL4 Chain-of-Trust] BLOCKED: No MCP context tool called recently.`,
                `Last RL4 consultation: ${(_h = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.age_seconds) !== null && _h !== void 0 ? _h : "?"}s ago (threshold: ${(_j = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.threshold_seconds) !== null && _j !== void 0 ? _j : 300}s).`,
                ``,
                `You MUST call an RL4 MCP tool (rl4_ask, search_context, get_evidence, get_timeline)`,
                `BEFORE writing code. This ensures your changes are grounded in project history.`,
            ].join("\n"));
            process.exit(2);
            return;
        }
        // OBSERVE mode: log + inject warning in lessons (don't block)
        // The warning will be prepended to the CRE lessons below
    }
    // Store full suggestion when we have an intervention_id + content
    if (result.intervention_id && fullContent) {
        try {
            const suggestionsDir = path.join(root, ".rl4", ".internal", "suggestions");
            if (!fs.existsSync(suggestionsDir))
                fs.mkdirSync(suggestionsDir, { recursive: true });
            const suggestionPath = path.join(suggestionsDir, `${result.intervention_id}.json`);
            lockedWrite(suggestionPath, JSON.stringify({
                intervention_id: result.intervention_id,
                file: relPath,
                timestamp: new Date().toISOString(),
                suggested_content: fullContent,
                old_string: (_k = ti === null || ti === void 0 ? void 0 : ti.old_string) !== null && _k !== void 0 ? _k : undefined,
                tool_name: (_l = input.tool_name) !== null && _l !== void 0 ? _l : "unknown",
                tool_input_hash: simpleHash(fullContent),
                hot_score: result.hot_score,
                decision: result.decision,
            }, null, 2));
            // TTL cleanup: delete suggestions older than 7 days (debounced — max once per hour via marker file)
            maybeCleanupStaleSuggestions(suggestionsDir);
        }
        catch { /* non-blocking — suggestion capture is best-effort */ }
    }
    // Build the lesson injection message
    const hasTrustWarning = !trustOk;
    if (result.lessons.length === 0 && result.avoid_patterns.length === 0 && !hasTrustWarning) {
        // No lessons and trust OK → allow silently
        process.exit(0);
        return;
    }
    // Format lessons with XML authority tags for RLHF compliance (Policy Puppetry)
    const lines = [];
    const hasAvoid = result.avoid_patterns.length > 0;
    const hasConstraints = result.hard_constraints.length > 0;
    // XML authority envelope for critical rules (AVOID + hard constraints)
    if (hasAvoid || hasConstraints) {
        lines.push(`<system_directive priority="CRITICAL" enforce="TRUE" source="rl4_cre">`);
        lines.push(`<instruction>CONSTRAINTS for ${relPath} — derived from verified project history.</instruction>`);
        for (const ap of result.avoid_patterns) {
            lines.push(`<rule severity="BLOCK">${ap}</rule>`);
        }
        for (const c of result.hard_constraints) {
            lines.push(`<rule severity="BLOCK">${c}</rule>`);
        }
        lines.push(`<penalty>Ignoring BLOCK rules re-introduces bugs. Re-read before generating code.</penalty>`);
        lines.push(`</system_directive>`);
    }
    // Non-critical context (flat text, lower priority)
    if (hasTrustWarning) {
        lines.push(`⚠️ CHAIN-OF-TRUST: No RL4 MCP tool called recently (${(_m = trustStatus === null || trustStatus === void 0 ? void 0 : trustStatus.age_seconds) !== null && _m !== void 0 ? _m : "?"}s ago). Consider calling rl4_ask or search_context before editing.`);
    }
    if (result.coupled_files.length > 0) {
        lines.push(`📎 COUPLED FILES: ${result.coupled_files.join(", ")} — check these too after editing`);
    }
    if (result.hot_score > 0.5) {
        lines.push(`🔥 HOT FILE (score: ${result.hot_score.toFixed(2)}, trajectory: ${result.trajectory})`);
    }
    for (const lesson of result.lessons.slice(0, 5)) {
        lines.push(`[${lesson.type}] ${lesson.text} (CRS: ${lesson.score})`);
    }
    const reason = lines.join("\n");
    // Log to gatekeeper_events.jsonl for Feed panel
    try {
        const eventsPath = path.join(root, ".rl4", ".internal", "gatekeeper_events.jsonl");
        lockedAppend(eventsPath, JSON.stringify({
            t: new Date().toISOString(),
            type: "validate",
            file: relPath,
            decision: result.decision,
            lessons_count: result.lessons.length,
            top_lesson: (_p = (_o = result.lessons[0]) === null || _o === void 0 ? void 0 : _o.text) !== null && _p !== void 0 ? _p : null,
            top_type: (_r = (_q = result.lessons[0]) === null || _q === void 0 ? void 0 : _q.type) !== null && _r !== void 0 ? _r : null,
            hot_score: result.hot_score,
            avoid_count: result.avoid_patterns.length,
            intervention_id: result.intervention_id,
            agent: "claude_code",
        }));
    }
    catch { /* non-blocking */ }
    // Smart enforcement: DENY only when AVOID pattern is violated in the diff.
    // Modes: soft (always allow), smart (deny on AVOID violation), hard (deny on any AVOID/reversal).
    const enforcement = (process.env.RL4_CRE_ENFORCEMENT || "smart").toLowerCase();
    if (enforcement === "smart" && result.decision === "DENY" && result.avoid_violated) {
        const violatedList = ((_s = result.violated_avoids) === null || _s === void 0 ? void 0 : _s.join("; ")) || "unknown pattern";
        outputDecision("deny", `[RL4 CRE] BLOCKED — AVOID pattern violated in your edit:\n⛔ Violated: ${violatedList}\n\n${reason}`);
        process.exit(2);
        return;
    }
    if (enforcement === "hard" && (result.decision === "DENY" || result.decision === "WARN")) {
        outputDecision("deny", `[RL4 CRE] BLOCKED (hard mode) — CRE lessons require attention:\n${reason}`);
        process.exit(2);
        return;
    }
    // Soft mode or no violation — allow with lessons as context
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
    try {
        const entry = {
            timestamp: new Date().toISOString(),
            file: relPath,
            tool: (_a = input.tool_name) !== null && _a !== void 0 ? _a : "unknown",
            session_id: (_b = input.session_id) !== null && _b !== void 0 ? _b : null,
        };
        lockedAppend(logPath, JSON.stringify(entry));
    }
    catch {
        // Non-blocking
    }
    process.exit(0);
}
// ── Suggestion Helpers ───────────────────────────────────────────────────────
/** Simple FNV-1a 32-bit hash for dedup — NOT cryptographic */
function simpleHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}
const CLEANUP_INTERVAL_MS = 3600000; // 1 hour
/** Check if cleanup should run by inspecting marker file mtime. */
function shouldRunCleanup(dir) {
    try {
        const marker = path.join(dir, ".last_cleanup");
        const stat = fs.statSync(marker);
        return Date.now() - stat.mtimeMs > CLEANUP_INTERVAL_MS;
    }
    catch {
        return true; // marker doesn't exist → run cleanup
    }
}
/** Touch marker file after successful cleanup. */
function touchCleanupMarker(dir) {
    try {
        fs.writeFileSync(path.join(dir, ".last_cleanup"), String(Date.now()));
    }
    catch { /* best-effort */ }
}
/** Delete suggestion files older than 7 days. Best-effort, non-blocking. */
function cleanupStaleSuggestions(dir) {
    try {
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > maxAge) {
                    fs.unlinkSync(fullPath);
                }
            }
            catch { /* skip individual file errors */ }
        }
    }
    catch { /* non-blocking */ }
}
/** Debounced cleanup — runs at most once per hour using marker file. */
function maybeCleanupStaleSuggestions(dir) {
    if (shouldRunCleanup(dir)) {
        cleanupStaleSuggestions(dir);
        touchCleanupMarker(dir);
    }
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
