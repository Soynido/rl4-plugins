#!/usr/bin/env node
var _a, _b, _c;
/**
 * RL4 MCP Server — evidence, timeline, decisions, search_context.
 * Bound to user UUID (RL4_USER_ID) and workspace (RL4_WORKSPACE_ROOT or set_workspace).
 * list_workspaces from Supabase; set_workspace to choose; get_* use .rl4/ local or Supabase when workspace !== "current".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getWorkspaceRoot, getEvidencePath, readEvidence, readTimeline, readIntentGraph, readFileSafe, loadLessonsForFile, appendAgentAction, readCausalLinks, readBurstSessions, readIntentGraphData, computeAvgDaysBetweenSaves, loadCREState, } from "./workspace.js";
import { rebuildAll, queryDateRange } from "./autoGenerate.js";
import { buildCouplingGraph, scoreLessons, scoreLessonsAdapted, selectSubmodular, stableLessonId, switchDREstimate, CRE_PARAMS, } from "./causal_engine.js";
import { logIntervention, resolveOutcomes, readAllInterventions } from "./cre_learner.js";
import { searchContext, formatPerplexityStyle, formatStructuredContent, formatStructuredIntentGraph } from "./search.js";
import { ask } from "./ask.js";
import { warmUpEngine } from "./rag.js";
import { resolveUnderRoot } from "./safePath.js";
import { buildCliSnapshot } from "./cliSnapshot.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { execFile } from "child_process";
const root = getWorkspaceRoot();
// Diagnostic: log how root was resolved
console.error(`[RL4 MCP] Root resolved: "${root}"`);
console.error(`[RL4 MCP] RL4_WORKSPACE_ROOT env: "${(_a = process.env.RL4_WORKSPACE_ROOT) !== null && _a !== void 0 ? _a : '(not set)'}"`);
console.error(`[RL4 MCP] CURSOR_WORKSPACE_DIR env: "${(_b = process.env.CURSOR_WORKSPACE_DIR) !== null && _b !== void 0 ? _b : '(not set)'}"`);
console.error(`[RL4 MCP] argv[2]: "${(_c = process.argv[2]) !== null && _c !== void 0 ? _c : '(not set)'}"`);
console.error(`[RL4 MCP] cwd: "${process.cwd()}"`);
// Validate workspace root exists at startup
if (root && !fs.existsSync(root)) {
    console.error(`[RL4 MCP] Warning: workspace root does not exist: ${root}`);
}
/** Whether this workspace has been explicitly connected (has .rl4/ already).
 *  When false, the MCP server still runs (Supabase tools work) but will NOT
 *  create .rl4/ or write local files — prevents polluting untracked workspaces. */
let workspaceTracked = false;
if (root) {
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    workspaceTracked = fs.existsSync(rl4Dir);
    if (workspaceTracked) {
        console.error(`[RL4 MCP] Workspace tracked: ${root}`);
    }
    else {
        console.error(`[RL4 MCP] Workspace NOT tracked (no .rl4/) — local tools read-only, use RL4: Connect to enable tracking: ${root}`);
    }
}
const TRIGGER_HEADLESS = ".trigger_headless_snapshot";
const HEADLESS_RESULT = ".headless_result.json";
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 90000; // 90s — no timeout accepted; extension may need time to wake
// Session: selected workspace (from set_workspace). "current" = use root; other = Supabase fetch.
let selectedWorkspaceId = null;
/** Load SUPABASE_URL, SUPABASE_ANON_KEY, RL4_ACCESS_TOKEN, RL4_REFRESH_TOKEN, RL4_API_KEY from ~/.rl4/mcp.env (written by extension on Connect). Enables MCP to work when invoked from another workspace that has no mcp.json. */
function loadSupabaseFromGlobalFile() {
    try {
        const home = os.homedir();
        if (!home)
            return {};
        const envPath = path.join(home, ".rl4", "mcp.env");
        if (!fs.existsSync(envPath))
            return {};
        const raw = fs.readFileSync(envPath, "utf-8");
        const out = {};
        for (const line of raw.split("\n")) {
            const i = line.indexOf("=");
            if (i <= 0)
                continue;
            const key = line.slice(0, i).trim();
            const value = line.slice(i + 1).trim();
            if (key && value)
                out[key] = value;
        }
        return {
            supabaseUrl: out.SUPABASE_URL,
            supabaseAnon: out.SUPABASE_ANON_KEY,
            accessToken: out.RL4_ACCESS_TOKEN,
            refreshToken: out.RL4_REFRESH_TOKEN,
            apiKey: out.RL4_API_KEY,
        };
    }
    catch {
        return {};
    }
}
/** Write updated tokens back to ~/.rl4/mcp.env (preserves existing keys, updates access + refresh tokens). */
function writeTokensToGlobalFile(accessToken, refreshToken) {
    try {
        const home = os.homedir();
        if (!home)
            return;
        const envPath = path.join(home, ".rl4", "mcp.env");
        if (!fs.existsSync(envPath))
            return;
        const raw = fs.readFileSync(envPath, "utf-8");
        const lines = raw.split("\n");
        const updated = [];
        let hasAccess = false, hasRefresh = false;
        for (const line of lines) {
            const i = line.indexOf("=");
            if (i <= 0) {
                updated.push(line);
                continue;
            }
            const key = line.slice(0, i).trim();
            if (key === "RL4_ACCESS_TOKEN") {
                updated.push(`RL4_ACCESS_TOKEN=${accessToken}`);
                hasAccess = true;
            }
            else if (key === "RL4_REFRESH_TOKEN") {
                updated.push(`RL4_REFRESH_TOKEN=${refreshToken}`);
                hasRefresh = true;
            }
            else {
                updated.push(line);
            }
        }
        if (!hasAccess)
            updated.push(`RL4_ACCESS_TOKEN=${accessToken}`);
        if (!hasRefresh)
            updated.push(`RL4_REFRESH_TOKEN=${refreshToken}`);
        fs.writeFileSync(envPath, updated.join("\n"), { encoding: "utf-8", mode: 0o600 });
        try {
            fs.chmodSync(envPath, 0o600);
        }
        catch { /* best-effort on Windows */ }
    }
    catch {
        /* best-effort */
    }
}
/** Mutex to prevent concurrent token refreshes (Supabase revokes session on double-use of refresh token). */
let mcpRefreshInProgress = null;
/** Attempt to refresh the Supabase access token using the refresh token from mcp.env.
 * On success, writes new tokens to mcp.env so subsequent calls use the fresh token.
 * Returns new config or null on failure. */
async function selfRefreshToken() {
    if (mcpRefreshInProgress) {
        const result = await mcpRefreshInProgress;
        if (result)
            return getSupabaseConfig(); // Re-read after refresh
        return null;
    }
    mcpRefreshInProgress = (async () => {
        try {
            const fromFile = loadSupabaseFromGlobalFile();
            const url = fromFile.supabaseUrl || process.env.SUPABASE_URL || "";
            const anon = fromFile.supabaseAnon || process.env.SUPABASE_ANON_KEY || "";
            const refreshTk = fromFile.refreshToken || process.env.RL4_REFRESH_TOKEN || "";
            if (!url || !anon || !refreshTk) {
                console.error("[RL4 MCP] No refresh token available for self-healing");
                return null;
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: anon },
                body: JSON.stringify({ refresh_token: refreshTk }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!res.ok) {
                console.error("[RL4 MCP] Token self-refresh failed:", res.status);
                return null;
            }
            const data = (await res.json());
            if (!data.access_token || !data.refresh_token)
                return null;
            // Write fresh tokens to mcp.env so all future reads pick them up
            writeTokensToGlobalFile(data.access_token, data.refresh_token);
            console.error("[RL4 MCP] Token self-refreshed successfully — mcp.env updated");
            return { accessToken: data.access_token, refreshToken: data.refresh_token };
        }
        catch (e) {
            console.error("[RL4 MCP] Token self-refresh error:", e);
            return null;
        }
        finally {
            mcpRefreshInProgress = null;
        }
    })();
    const result = await mcpRefreshInProgress;
    if (result)
        return getSupabaseConfig();
    return null;
}
/** Supabase config: always prefer ~/.rl4/mcp.env when present (extension writes fresh token on Connect/activation). Avoids 401 after Reload when Cursor started MCP with stale env. */
function getSupabaseConfig() {
    const fromFile = loadSupabaseFromGlobalFile();
    const url = fromFile.supabaseUrl || process.env.SUPABASE_URL || "";
    const anon = fromFile.supabaseAnon || process.env.SUPABASE_ANON_KEY || "";
    const token = fromFile.accessToken || process.env.RL4_ACCESS_TOKEN || "";
    const apiKey = fromFile.apiKey || process.env.RL4_API_KEY || "";
    if (url && anon && token)
        return { supabaseUrl: url, supabaseAnon: anon, accessToken: token, ...(apiKey ? { apiKey } : {}) };
    return null;
}
// --- API Key validation (revocable device keys) ---
import { createHash } from "crypto";
let apiKeyValidated = null; // null = not checked yet, true = valid, false = revoked/invalid
let apiKeyValidationError = null;
/** Validate API key against Supabase. Called once per MCP session on first Supabase operation. */
async function validateApiKey() {
    if (apiKeyValidated !== null)
        return apiKeyValidated;
    let cfg = getSupabaseConfig();
    if (!(cfg === null || cfg === void 0 ? void 0 : cfg.apiKey)) {
        // No API key configured — allow for backward compatibility (pre-api-key users)
        apiKeyValidated = true;
        return true;
    }
    try {
        const keyHash = createHash("sha256").update(cfg.apiKey).digest("hex");
        const doFetch = async (c) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/validate_api_key`, {
                method: "POST",
                headers: {
                    apikey: c.supabaseAnon,
                    Authorization: `Bearer ${c.accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ p_key_hash: keyHash }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return res;
        };
        let res = await doFetch(cfg);
        if (res.status === 401) {
            const refreshedCfg = await selfRefreshToken();
            if (refreshedCfg) {
                cfg = refreshedCfg;
                res = await doFetch(cfg);
            }
        }
        if (!res.ok) {
            // RPC doesn't exist yet (migration not applied) — allow gracefully
            if (res.status === 404) {
                apiKeyValidated = true;
                return true;
            }
            apiKeyValidated = true; // Don't block on transient errors
            return true;
        }
        const data = (await res.json());
        if (data.valid) {
            apiKeyValidated = true;
            return true;
        }
        apiKeyValidated = false;
        apiKeyValidationError = data.reason === "revoked"
            ? `API key revoked${data.revoked_at ? ` at ${data.revoked_at}` : ""}. Run **RL4: Connect** in the Command Palette to generate a new key.`
            : `API key invalid (${data.reason || "unknown"}). Run **RL4: Connect** to re-authenticate.`;
        return false;
    }
    catch {
        // Network error — don't block, allow gracefully
        apiKeyValidated = true;
        return true;
    }
}
/** Guard: returns error text if API key is revoked, or null if access is allowed. */
async function checkApiKeyAccess() {
    const valid = await validateApiKey();
    if (!valid)
        return apiKeyValidationError || "API key revoked. Run **RL4: Connect** to re-authenticate.";
    return null;
}
function isRemoteWorkspace() {
    return selectedWorkspaceId != null && selectedWorkspaceId !== "current";
}
// --- Context On-Chain: log context references to landing (Dashboard → Context Flows) ---
const workspaceNameCache = new Map();
/** Previous workspace id/name for set_workspace "from" (same auth as client-setup). */
let previousWorkspaceId = null;
let previousWorkspaceName = null;
const CONTEXT_REFERENCE_URL = "https://rl4.ai/api/sync/context-reference";
/** Current workspace id and human-readable name (for "current" or selected Supabase workspace). */
function getCurrentWorkspaceIdAndName() {
    var _a;
    if (selectedWorkspaceId && selectedWorkspaceId !== "current") {
        const name = (_a = workspaceNameCache.get(selectedWorkspaceId)) !== null && _a !== void 0 ? _a : selectedWorkspaceId;
        return { id: selectedWorkspaceId, name };
    }
    const name = root ? path.basename(root) || "current" : "current";
    return { id: "current", name };
}
/** Fire-and-forget: log context reference to landing API (same auth as client-setup). Do not await in hot path. */
function logContextReference(payload) {
    var _a, _b, _c, _d;
    const cfg = getSupabaseConfig();
    if (!(cfg === null || cfg === void 0 ? void 0 : cfg.accessToken))
        return;
    const body = {
        from_workspace_id: (_a = payload.from_workspace_id) !== null && _a !== void 0 ? _a : null,
        from_workspace_name: (_b = payload.from_workspace_name) !== null && _b !== void 0 ? _b : null,
        to_workspace_id: payload.to_workspace_id,
        to_workspace_name: payload.to_workspace_name,
        action: payload.action,
        query_text: (_d = (_c = payload.query_text) === null || _c === void 0 ? void 0 : _c.slice(0, 2000)) !== null && _d !== void 0 ? _d : null,
    };
    fetch(CONTEXT_REFERENCE_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.accessToken}`,
        },
        body: JSON.stringify(body),
    }).catch(() => { }); // Fire-and-forget: do not block UX or surface errors
}
function getEffectiveRoot() {
    return isRemoteWorkspace() ? "" : root;
}
let workspaceContextCache = null;
async function fetchWorkspaceContextFromSupabase(workspaceId) {
    var _a, _b;
    // Check API key before any Supabase call
    const keyErr = await checkApiKeyAccess();
    if (keyErr)
        return { evidence: keyErr, timeline: keyErr, decisions: keyErr, intent_graph: keyErr };
    let cfg = getSupabaseConfig();
    const err = "[Supabase not configured. Set SUPABASE_URL and RL4_ACCESS_TOKEN, or run RL4: Connect from any workspace.]";
    if (!cfg)
        return { evidence: err, timeline: err, decisions: err, intent_graph: err };
    // Helper to make the actual fetch with a given config
    const doFetch = async (c) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/get_rl4_workspace_context`, {
            method: "POST",
            headers: {
                apikey: c.supabaseAnon,
                Authorization: `Bearer ${c.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_workspace_id: workspaceId }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
    };
    try {
        let res = await doFetch(cfg);
        // Self-heal on 401: refresh token and retry once
        if (res.status === 401) {
            console.error("[RL4 MCP] 401 on workspace context — attempting self-refresh...");
            const refreshedCfg = await selfRefreshToken();
            if (refreshedCfg) {
                cfg = refreshedCfg;
                res = await doFetch(cfg);
            }
        }
        if (!res.ok) {
            const base = `[Supabase error ${res.status}.]`;
            const msg = res.status === 401 ? base + " Token expired and self-refresh failed. Run RL4: Connect + Reload Window." : base;
            return { evidence: msg, timeline: msg, decisions: msg, intent_graph: msg };
        }
        const data = (await res.json());
        const evidenceMd = (_a = data.evidence) !== null && _a !== void 0 ? _a : "";
        const timelineMd = (_b = data.timeline) !== null && _b !== void 0 ? _b : "";
        const decisionsJson = data.decisions;
        const arr = Array.isArray(decisionsJson) ? decisionsJson : [];
        const lines = arr.map((d) => { var _a, _b, _c, _d, _e; return `- [${(_a = d.id) !== null && _a !== void 0 ? _a : ""}] ${(_b = d.isoTimestamp) !== null && _b !== void 0 ? _b : ""} | ${(_c = d.intent_text) !== null && _c !== void 0 ? _c : ""} → ${(_d = d.chosen_option) !== null && _d !== void 0 ? _d : ""} (gate: ${(_e = d.confidence_gate) !== null && _e !== void 0 ? _e : ""})`; });
        const decisionsText = `Source: Supabase rl4_workspace_decisions (workspace ${workspaceId})\n\n${lines.length ? lines.join("\n") : "[No decisions.]"}`;
        const intentGraphJson = data.intent_graph;
        const intentGraphText = intentGraphJson != null && typeof intentGraphJson === "object"
            ? `Source: Supabase rl4_workspace_intent_graph (workspace ${workspaceId})\n\n${JSON.stringify(intentGraphJson, null, 2)}`
            : `[No intent_graph for this workspace in Supabase. Sync from extension (snapshot/startup).]`;
        return {
            evidence: evidenceMd ? `Source: Supabase rl4_workspace_evidence (workspace ${workspaceId})\n\n${evidenceMd}` : `[No evidence for this workspace in Supabase. Sync from extension (snapshot/startup).]`,
            timeline: timelineMd ? `Source: Supabase rl4_workspace_timeline (workspace ${workspaceId})\n\n${timelineMd}` : `[No timeline for this workspace in Supabase. Sync from extension (snapshot/startup).]`,
            decisions: decisionsText,
            intent_graph: intentGraphText,
        };
    }
    catch (e) {
        const msg = `[Failed to fetch context from Supabase: ${e instanceof Error ? e.message : String(e)}]`;
        return { evidence: msg, timeline: msg, decisions: msg, intent_graph: msg };
    }
}
async function fetchEvidenceFromSupabase(workspaceId) {
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) === workspaceId)
        return workspaceContextCache.data.evidence;
    const data = await fetchWorkspaceContextFromSupabase(workspaceId);
    workspaceContextCache = { workspaceId, data };
    return data.evidence;
}
async function fetchTimelineFromSupabase(workspaceId) {
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) === workspaceId)
        return workspaceContextCache.data.timeline;
    const data = await fetchWorkspaceContextFromSupabase(workspaceId);
    workspaceContextCache = { workspaceId, data };
    return data.timeline;
}
async function fetchIntentGraphFromSupabase(workspaceId) {
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) === workspaceId)
        return workspaceContextCache.data.intent_graph;
    const data = await fetchWorkspaceContextFromSupabase(workspaceId);
    workspaceContextCache = { workspaceId, data };
    return data.intent_graph;
}
const mcpServer = new McpServer({
    name: "rl4-mcp-server",
    version: "0.1.0",
});
// --- Resources (read-only) ---
mcpServer.resource("evidence", "rl4://workspace/evidence", { description: "RL4 evidence.md — mechanical facts, sessions, activity (citation source first)" }, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchEvidenceFromSupabase(selectedWorkspaceId)
        : readEvidence(root);
    return {
        contents: [{ uri: "rl4://workspace/evidence", mimeType: "text/markdown", text }],
    };
});
mcpServer.resource("timeline", "rl4://workspace/timeline", { description: "RL4 timeline.md — developer journal, narratives (citation source first)" }, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchTimelineFromSupabase(selectedWorkspaceId)
        : readTimeline(root);
    return {
        contents: [{ uri: "rl4://workspace/timeline", mimeType: "text/markdown", text }],
    };
});
// decisions resource removed — same reason as get_decisions tool above.
mcpServer.resource("intent_graph", "rl4://workspace/intent_graph", { description: "RL4 MIG intent_graph.json — aggregated intent graph (chains, trajectories, hot scores)" }, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchIntentGraphFromSupabase(selectedWorkspaceId)
        : readIntentGraph(root);
    return {
        contents: [{ uri: "rl4://workspace/intent_graph", mimeType: "application/json", text }],
    };
});
// --- Tools ---
mcpServer.tool("get_evidence", "Get project evidence — mechanical facts, work sessions, file activity, and development patterns. Use when the user asks about what happened in the project, recent activity, work sessions, or factual project history. Returns structured, cited sections.", {}, async () => {
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "get_evidence" });
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const raw = await fetchEvidenceFromSupabase(selectedWorkspaceId);
        const text = formatStructuredContent("project evidence", raw, `Supabase workspace ${selectedWorkspaceId}`, "This is the project evidence — mechanical facts about development activity. Use these sections to answer questions about what happened, when sessions occurred, which files were modified, and overall project patterns.");
        return { content: [{ type: "text", text }] };
    }
    console.error(`[RL4 MCP] get_evidence: reading from root="${root}", path="${getEvidencePath(root)}", exists=${fs.existsSync(getEvidencePath(root))}`);
    const raw = readEvidence(root);
    const text = formatStructuredContent("project evidence", raw, ".rl4/evidence.md", "This is the project evidence — mechanical facts about development activity. Use these sections to answer questions about what happened, when sessions occurred, which files were modified, and overall project patterns.");
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("get_timeline", "Get the development timeline. Without date params: returns compact date index (one row per active day). With date_from/date_to: returns RICH forensic detail — sessions, file changes, actual chat message summaries, thread titles. Use date params when the user asks 'what was done on [date]' or 'what happened between [date] and [date]'.", {
    date_from: z.string().optional().describe("Start date (YYYY-MM-DD). When provided with date_to, returns rich per-day detail from JSONL evidence."),
    date_to: z.string().optional().describe("End date (YYYY-MM-DD). When provided with date_from, returns rich per-day detail from JSONL evidence."),
}, async ({ date_from, date_to }) => {
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "get_timeline" });
    // Rich date-range query mode — live JSONL query
    if (date_from && date_to) {
        if (isRemoteWorkspace() && selectedWorkspaceId) {
            // Remote doesn't have JSONL access — fall back to Supabase timeline
            const raw = await fetchTimelineFromSupabase(selectedWorkspaceId);
            const text = formatStructuredContent("development timeline", raw, `Supabase workspace ${selectedWorkspaceId}`, "This is the development timeline from a remote workspace. Date filtering is only available for local workspaces.");
            return { content: [{ type: "text", text }] };
        }
        const detail = queryDateRange(root, date_from, date_to);
        return { content: [{ type: "text", text: detail }] };
    }
    // Default mode — compact index from timeline.md
    const synthesisHint = "This is a compact date index. For rich detail on any date, call get_timeline again with date_from and date_to parameters.";
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const raw = await fetchTimelineFromSupabase(selectedWorkspaceId);
        const text = formatStructuredContent("development timeline", raw, `Supabase workspace ${selectedWorkspaceId}`, synthesisHint);
        return { content: [{ type: "text", text }] };
    }
    const raw = readTimeline(root);
    const text = formatStructuredContent("development timeline", raw, ".rl4/timeline.md", synthesisHint);
    return { content: [{ type: "text", text }] };
});
// get_decisions removed — low-quality output (timeline regex parse with hardcoded confidence).
// Decisions are better served by search_context(source:"timeline") or rl4_ask.
mcpServer.tool("get_intent_graph", "Get the intent graph — maps which files are edited together, hot areas of the codebase, development workflow patterns, and activity chains. Use when the user asks about codebase structure, most active files, common editing patterns, or development workflows. Returns structured sections.", {}, async () => {
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const raw = await fetchIntentGraphFromSupabase(selectedWorkspaceId);
        const text = formatStructuredIntentGraph(raw, `Supabase workspace ${selectedWorkspaceId}`);
        return { content: [{ type: "text", text }] };
    }
    const raw = readIntentGraph(root);
    const text = formatStructuredIntentGraph(raw, ".rl4/intent_graph.json");
    return { content: [{ type: "text", text }] };
});
// --- RL4 Connect: list workspaces (Supabase), set workspace ---
async function listWorkspacesFromSupabase() {
    let cfg = getSupabaseConfig();
    if (!cfg)
        return { workspaces: [] };
    const doFetch = async (c) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${c.supabaseUrl}/rest/v1/user_workspaces?select=workspace_id,workspace_name,snapshot_count,last_active_at&order=last_active_at.desc`, {
            headers: {
                apikey: c.supabaseAnon,
                Authorization: `Bearer ${c.accessToken}`,
                "Content-Type": "application/json",
            },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
    };
    try {
        let res = await doFetch(cfg);
        // Self-heal on 401: refresh token and retry once
        if (res.status === 401) {
            console.error("[RL4 MCP] 401 on list_workspaces — attempting self-refresh...");
            const refreshedCfg = await selfRefreshToken();
            if (refreshedCfg) {
                cfg = refreshedCfg;
                res = await doFetch(cfg);
            }
        }
        if (res.status === 401)
            return { workspaces: [], authError: true };
        if (!res.ok)
            return { workspaces: [] };
        const data = (await res.json());
        return { workspaces: data !== null && data !== void 0 ? data : [] };
    }
    catch {
        return { workspaces: [] };
    }
}
/** Fetch workspaces shared WITH the current user (read-only access via workspace_shares). */
async function listSharedWorkspacesFromSupabase() {
    const cfg = getSupabaseConfig();
    if (!cfg)
        return [];
    const doFetch = async (c) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/list_shared_workspaces`, {
            method: "POST",
            headers: {
                apikey: c.supabaseAnon,
                Authorization: `Bearer ${c.accessToken}`,
                "Content-Type": "application/json",
            },
            body: "{}",
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
    };
    try {
        let res = await doFetch(cfg);
        if (res.status === 401) {
            const refreshedCfg = await selfRefreshToken();
            if (refreshedCfg)
                res = await doFetch(refreshedCfg);
        }
        if (!res.ok)
            return [];
        const data = (await res.json());
        return data !== null && data !== void 0 ? data : [];
    }
    catch {
        return [];
    }
}
/** Fetch teammates' workspaces auto-discovered via shared repo_id (git remote). */
async function listRepoTeammatesFromSupabase() {
    const cfg = getSupabaseConfig();
    if (!cfg)
        return [];
    const doFetch = async (c) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/list_repo_teammates`, {
            method: "POST",
            headers: {
                apikey: c.supabaseAnon,
                Authorization: `Bearer ${c.accessToken}`,
                "Content-Type": "application/json",
            },
            body: "{}",
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
    };
    try {
        let res = await doFetch(cfg);
        if (res.status === 401) {
            const refreshedCfg = await selfRefreshToken();
            if (refreshedCfg)
                res = await doFetch(refreshedCfg);
        }
        if (!res.ok)
            return [];
        const data = (await res.json());
        return data !== null && data !== void 0 ? data : [];
    }
    catch {
        return [];
    }
}
mcpServer.tool("list_workspaces", "List workspaces for the current user (from Supabase). Call this when user says /RL4 or 'Use RL4' so they can choose a workspace. Returns workspace_id, workspace_name, snapshot_count, last_active_at.", {}, async () => {
    var _a;
    // Validate API key on first Supabase call
    const keyError = await checkApiKeyAccess();
    if (keyError)
        return { content: [{ type: "text", text: keyError }], isError: true };
    const hasSupabase = !!getSupabaseConfig();
    const [{ workspaces, authError }, sharedWorkspaces, teamWorkspaces] = await Promise.all([
        listWorkspacesFromSupabase(),
        listSharedWorkspacesFromSupabase(),
        listRepoTeammatesFromSupabase(),
    ]);
    // Populate workspace name cache for context on-chain logging
    workspaces.forEach(w => workspaceNameCache.set(w.workspace_id, w.workspace_name));
    sharedWorkspaces.forEach(w => workspaceNameCache.set(w.workspace_id, w.workspace_name));
    teamWorkspaces.forEach(w => workspaceNameCache.set(w.workspace_id, w.workspace_name));
    const currentName = root ? (_a = root.split(/[/\\]/).filter(Boolean).pop()) !== null && _a !== void 0 ? _a : "current" : "current";
    // Deduplicate: exclude team workspaces that are already in shared list
    const sharedIds = new Set(sharedWorkspaces.map(w => w.workspace_id));
    const ownIds = new Set(workspaces.map(w => w.workspace_id));
    const uniqueTeamWorkspaces = teamWorkspaces.filter(w => !sharedIds.has(w.workspace_id) && !ownIds.has(w.workspace_id));
    let text;
    if (workspaces.length > 0 || sharedWorkspaces.length > 0 || uniqueTeamWorkspaces.length > 0) {
        const sameAsSupabase = workspaces.some((w) => w.workspace_name === currentName);
        const currentLine = sameAsSupabase
            ? `**Current folder**: "${currentName}" — same project as a workspace above. Use set_workspace("current") for local .rl4/, or the workspace id above for Supabase.`
            : `**Current folder** (this Cursor workspace): "${currentName}". To use it, call set_workspace with workspace_id "current".`;
        let idx = 0;
        const ownLines = workspaces.length > 0
            ? `**Your workspaces:**\n${workspaces.map((w) => { var _a; return `${++idx}. ${w.workspace_name} (id: ${w.workspace_id}, snapshots: ${(_a = w.snapshot_count) !== null && _a !== void 0 ? _a : 0})`; }).join("\n")}`
            : "";
        const sharedLines = sharedWorkspaces.length > 0
            ? `\n\n**Shared with you** (read-only):\n${sharedWorkspaces.map((w) => `${++idx}. ${w.workspace_name} (id: ${w.workspace_id}, shared by: ${w.owner_email})`).join("\n")}`
            : "";
        const teamLines = uniqueTeamWorkspaces.length > 0
            ? `\n\n**Team — same repo** (read-only, auto-discovered):\n${uniqueTeamWorkspaces.map((w) => `${++idx}. ${w.workspace_name} (id: ${w.workspace_id}, by: ${w.owner_email}, repo: ${w.repo_id})`).join("\n")}`
            : "";
        text = `${ownLines}${sharedLines}${teamLines}\n\n${currentLine}`;
    }
    else if (!hasSupabase) {
        text = `Supabase not configured for MCP (missing SUPABASE_URL or RL4_ACCESS_TOKEN in env). Run **RL4: Connect** in the palette so the extension writes .cursor/mcp.json with env, then **Reload Window**. Use **current** workspace: "${currentName}".`;
    }
    else if (authError) {
        text = `Supabase returned 401 (token expired and auto-refresh failed). Run **RL4: Connect** (Cmd+Shift+P) then **Reload Window** so the MCP gets a fresh token.

**Fallback:** For the current folder context, you can read .rl4/evidence.md and .rl4/timeline.md directly via the Read tool. Offer: "En attendant, je peux charger evidence.md et timeline.md du dossier actuel — voulez-vous que je le fasse ?"`;
    }
    else {
        text = `No workspaces in Supabase yet (Supabase is configured; table may be empty or RLS). Use **current** workspace: "${currentName}". After a snapshot from the extension, workspaces should appear.`;
    }
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("set_workspace", "Set the active workspace for get_evidence, get_timeline, search_context. Use workspace_id 'current' to use this Cursor workspace's .rl4/ data; use a workspace id from list_workspaces to read from Supabase.", { workspace_id: z.string().describe("Workspace id from list_workspaces, or 'current' for this folder") }, async (args) => {
    var _a, _b;
    const rawId = String((_a = args.workspace_id) !== null && _a !== void 0 ? _a : "current").trim();
    const id = /^[a-zA-Z0-9_-]+$/.test(rawId) ? rawId : "current";
    const isRemote = id !== "current";
    const toName = isRemote ? ((_b = workspaceNameCache.get(id)) !== null && _b !== void 0 ? _b : `Supabase workspace ${id}`) : (root ? path.basename(root) || "current" : "current");
    // Log context reference (from = previous, to = just set) then update previous for next set_workspace
    logContextReference({
        from_workspace_id: previousWorkspaceId !== null && previousWorkspaceId !== void 0 ? previousWorkspaceId : undefined,
        from_workspace_name: previousWorkspaceName !== null && previousWorkspaceName !== void 0 ? previousWorkspaceName : undefined,
        to_workspace_id: id,
        to_workspace_name: toName,
        action: "set_workspace",
    });
    previousWorkspaceId = id;
    previousWorkspaceName = toName;
    selectedWorkspaceId = id;
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) !== id)
        workspaceContextCache = null;
    return {
        content: [
            {
                type: "text",
                text: isRemote
                    ? `Workspace set to **${id}** (Supabase). RL4 context is ready: use get_evidence, get_timeline, or search_context(query).`
                    : `Workspace set to **current** (${toName}). RL4 context is ready: use get_evidence, get_timeline, or search_context(query).`,
            },
        ],
    };
});
// --- Supabase search: fetch full context then search in-memory (rl4_chunks table is not populated) ---
async function searchContextFromSupabase(workspaceId, query, limit) {
    // Fetch full context from the RPC that IS populated (evidence, timeline, decisions)
    const ctx = await fetchWorkspaceContextFromSupabase(workspaceId);
    const allText = [ctx.evidence, ctx.timeline, ctx.decisions].filter(Boolean).join("\n\n");
    if (!allText || allText.startsWith("[Supabase") || allText.startsWith("[Failed")) {
        return allText || `[No context for workspace ${workspaceId}. Sync from extension first.]`;
    }
    // In-memory search: split into paragraphs, score by query term overlap
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const paragraphs = allText.split(/\n{2,}/).filter(p => p.trim().length > 20);
    const scored = paragraphs.map(p => {
        const pLower = p.toLowerCase();
        const score = queryTerms.reduce((s, term) => s + (pLower.includes(term) ? 1 : 0), 0);
        return { text: p.trim(), score };
    }).filter(p => p.score > 0);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.min(limit, 20));
    if (top.length === 0) {
        return `No matching content for "${query}" in workspace ${workspaceId}. The workspace has context synced — try get_evidence, get_timeline, or search_context for full data.`;
    }
    // Format as Perplexity-style stepped output
    const MAX_REMOTE_TOTAL = 15000;
    const lines = [];
    // ── STEP 1: SEARCH ──
    lines.push(`**Step 1 — Search**: Queried remote workspace ${workspaceId} for "${query}"`);
    lines.push(`Found **${top.length} sources** from synced context\n`);
    // ── STEP 2: SOURCES ──
    lines.push(`**Step 2 — Sources**:\n`);
    let totalChars = lines.join("\n").length;
    for (let i = 0; i < top.length; i++) {
        const num = i + 1;
        const excerpt = top[i].text.length > 1000 ? top[i].text.slice(0, 1000) + "…" : top[i].text;
        const entry = `**[${num}]**\n${excerpt}\n`;
        if (totalChars + entry.length > MAX_REMOTE_TOTAL) {
            lines.push(`\n*[${top.length - i} more sources omitted]*`);
            break;
        }
        lines.push(entry);
        totalChars += entry.length;
    }
    // ── STEP 3: SYNTHESIZE ──
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: Using the ${top.length} sources above, answer "${query}".`);
    lines.push(`- Cite inline as [1], [2]. Be direct and specific. No preamble.`);
    return lines.join("\n");
}
const SearchFiltersSchema = z.object({
    query: z.string().describe("Search query (natural language or keywords)"),
    source: z.enum(["evidence", "timeline", "decisions", "chat", "cli"]).optional().describe("Filter by source"),
    tag: z.string().optional().describe("Filter by tag (e.g. FIX, UI, ARCH, DOCS, CLI, GIT)"),
    file: z.string().optional().describe("Filter by file path (substring)"),
    date_from: z.string().optional().describe("Filter from date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Filter to date (YYYY-MM-DD)"),
    limit: z.number().min(1).max(20).optional().default(10).describe("Max chunks to return"),
});
mcpServer.tool("search_chats", "Search past conversations and chat history. Use when the user asks about previous discussions, what was said about a topic, or past AI conversations. Returns cited sources with relevance indicators.", { query: z.string().describe("Search query"), limit: z.number().min(1).max(20).optional().default(10) }, async (args) => {
    const parsed = z.object({ query: z.string(), limit: z.number().min(1).max(20).optional().default(10) }).safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit } = parsed.data;
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "search_chats", query_text: query });
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit);
        return { content: [{ type: "text", text }] };
    }
    const result = searchContext(root, query, { source: "chat", limit });
    const text = result.chunks.length === 0
        ? `No matching chat messages for "${query}". Chat history is in .rl4/evidence/chat_history.jsonl (filled by extension on startup).`
        : formatPerplexityStyle(query, result, "chat history");
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("search_cli", "Search terminal and command history — git, npm, build, test, deploy commands with results. Use when the user asks about commands they ran, build errors, test results, deploys, or terminal activity.", { query: z.string().describe("Search query"), limit: z.number().min(1).max(20).optional().default(10) }, async (args) => {
    const parsed = z.object({ query: z.string(), limit: z.number().min(1).max(20).optional().default(10) }).safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit } = parsed.data;
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "search_cli", query_text: query });
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit);
        return { content: [{ type: "text", text }] };
    }
    const result = searchContext(root, query, { source: "cli", limit });
    const text = result.chunks.length === 0
        ? `No matching CLI commands for "${query}". CLI history is in .rl4/evidence/cli_history.jsonl (filled by shell hooks or rl4 wrap).`
        : formatPerplexityStyle(query, result, "CLI history");
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("search_context", "Search across all project context — code, evidence, timeline, decisions, chat history, and CLI commands. The main search tool: use for any question about the codebase, project history, or development activity. Supports filtering by source type, date range, tags, and file paths. Returns cited sources with relevance scores.", SearchFiltersSchema.shape, async (args) => {
    const parsed = SearchFiltersSchema.safeParse(args);
    if (!parsed.success) {
        return {
            content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
            isError: true,
        };
    }
    const { query, source, tag, file, date_from, date_to, limit } = parsed.data;
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "search_context", query_text: query });
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit !== null && limit !== void 0 ? limit : 10);
        return { content: [{ type: "text", text }] };
    }
    const filters = { source, tag, file, date_from, date_to, limit };
    const result = searchContext(root, query, filters);
    const sourceLabel = source ? `${source} context` : "development context";
    const text = result.chunks.length === 0
        ? `No matching chunks for query "${query}".`
        : formatPerplexityStyle(query, result, sourceLabel);
    return {
        content: [{ type: "text", text }],
    };
});
// ── rl4_ask: Perplexity-style answer engine ──────────────────────────────────
const AskSchema = z.object({
    query: z.string().describe("Natural language question about the codebase, how code works, project history, past discussions, or anything about this project"),
    source: z.enum(["evidence", "timeline", "decisions", "chat", "cli"]).optional().describe("Filter by source type"),
    tag: z.string().optional().describe("Filter by tag (e.g. FIX, UI, ARCH)"),
    date_from: z.string().optional().describe("Filter from date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Filter to date (YYYY-MM-DD)"),
    limit: z.number().min(1).max(20).optional().default(5).describe("Max sources to cite (default 5)"),
});
mcpServer.tool("rl4_ask", "Ask ANY question about this project — how the code works, what was built, architecture, past discussions, decisions, or debugging. Works like Perplexity but for your codebase: indexes ALL source files + chat history + decisions + timeline. Use this FIRST before exploring files manually. Returns cited answers with sources.", AskSchema.shape, async (args) => {
    var _a;
    const parsed = AskSchema.safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    const { id: toId, name: toName } = getCurrentWorkspaceIdAndName();
    logContextReference({ to_workspace_id: toId, to_workspace_name: toName, action: "rl4_ask", query_text: parsed.data.query });
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const { query } = parsed.data;
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, (_a = parsed.data.limit) !== null && _a !== void 0 ? _a : 5);
        return { content: [{ type: "text", text: `**rl4_ask (remote workspace — in-memory search)**\n\n${text}` }] };
    }
    const { query, source, tag, date_from, date_to, limit } = parsed.data;
    const options = { source, tag, date_from, date_to, limit };
    const result = ask(root, query, options);
    // Format the Perplexity-style response: synthesis instruction + sources + metadata
    const sections = [];
    // The answer already contains the synthesis instruction + numbered sources (from ask.ts)
    sections.push(result.answer);
    // Query analysis metadata (compact, helps LLM understand retrieval quality)
    const meta = [];
    meta.push(`Intent: ${result.analysis.intent} (${(result.analysis.intentConfidence * 100).toFixed(0)}%)`);
    meta.push(`Match: ${(result.confidence * 100).toFixed(0)}%`);
    if (result.analysis.entities.files.length > 0)
        meta.push(`Files: ${result.analysis.entities.files.join(", ")}`);
    if (result.analysis.entities.tags.length > 0)
        meta.push(`Tags: ${result.analysis.entities.tags.join(", ")}`);
    if (result.analysis.expandedTerms.length > 3)
        meta.push(`Expanded: ${result.analysis.expandedTerms.slice(0, 6).join(", ")}`);
    sections.push(`\n---\n*${meta.join(" | ")}*`);
    // Related questions for follow-up
    if (result.relatedQuestions.length > 0) {
        sections.push(`\n**Follow-up questions:**`);
        result.relatedQuestions.forEach((q, i) => sections.push(`${i + 1}. ${q}`));
    }
    sections.push(`\n*${result.stats.returnedChunks} sources from ${result.stats.filteredChunks} chunks (${result.stats.totalChunks} total) in ${result.stats.searchTimeMs}ms*`);
    return { content: [{ type: "text", text: sections.join("\n") }] };
});
// ── Compact snapshot summary (replaces 76K prompt with ~2K queryable summary) ──
/** Extract basic stats from an IDE-generated prompt string */
function extractStatsFromPrompt(prompt) {
    const msgMatch = prompt.match(/messages_count[=:]\s*(\d+)/i) || prompt.match(/(\d+)\s+messages?\s+from/i);
    const threadMatch = prompt.match(/threads_count[=:]\s*(\d+)/i) || prompt.match(/(\d+)\s+threads/i);
    const srcMatch = prompt.match(/sources[=:].*?(cursor|claude_code|vscode)/gi);
    return {
        messages: msgMatch ? parseInt(msgMatch[1]) : 0,
        threads: threadMatch ? parseInt(threadMatch[1]) : 0,
        sources: srcMatch ? [...new Set(srcMatch.map(s => s.replace(/.*?(?=cursor|claude_code|vscode)/i, "").toLowerCase()))] : [],
    };
}
/** Format a compact snapshot summary (~2K chars) instead of the full 76K prompt */
function formatSnapshotSummary(stats, wsRoot) {
    var _a, _b, _c;
    const wsName = path.basename(wsRoot);
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    // Read activity summary for hot files
    let hotFiles = [];
    let lastModified = "";
    let sessionsCount = 0;
    let filesTracked = 0;
    try {
        const actPath = resolveUnderRoot(wsRoot, ".rl4", "evidence", "activity.jsonl");
        if (fs.existsSync(actPath)) {
            const lines = fs.readFileSync(actPath, "utf8").split("\n").filter(Boolean);
            const counts = {};
            let lastP = "", lastT = "";
            for (const l of lines.slice(-50)) {
                try {
                    const e = JSON.parse(l);
                    const p = (_b = (_a = e === null || e === void 0 ? void 0 : e.path) !== null && _a !== void 0 ? _a : e === null || e === void 0 ? void 0 : e.from) !== null && _b !== void 0 ? _b : "";
                    if (p) {
                        counts[p] = (counts[p] || 0) + 1;
                        lastP = p;
                        lastT = (_c = e === null || e === void 0 ? void 0 : e.t) !== null && _c !== void 0 ? _c : lastT;
                    }
                }
                catch { /* skip */ }
            }
            hotFiles = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, c]) => `${path.basename(p)} (${c})`);
            lastModified = lastT ? new Date(lastT).toISOString().slice(0, 19).replace("T", " ") : "";
            filesTracked = Object.keys(counts).length;
        }
    }
    catch { /* best effort */ }
    try {
        const sessPath = resolveUnderRoot(wsRoot, ".rl4", "evidence", "sessions.jsonl");
        if (fs.existsSync(sessPath)) {
            sessionsCount = fs.readFileSync(sessPath, "utf8").split("\n").filter(Boolean).length;
        }
    }
    catch { /* best effort */ }
    // File index stats
    let blobFiles = 0;
    try {
        const fiPath = resolveUnderRoot(wsRoot, ".rl4", "snapshots", "file_index.json");
        if (fs.existsSync(fiPath)) {
            const fi = JSON.parse(fs.readFileSync(fiPath, "utf8"));
            blobFiles = Object.keys(fi).length;
        }
    }
    catch { /* best effort */ }
    // Time savings formula
    const timeSavedMin = (stats.messages * 1.5) + (filesTracked * 2) + (sessionsCount * 10);
    const timeSavedStr = timeSavedMin >= 30 ? `~${(timeSavedMin / 60).toFixed(1)}h` : `~${Math.round(timeSavedMin)}min`;
    const lines = [
        `RL4 Snapshot Complete — ${wsName}`,
        `Timestamp: ${now}`,
        ``,
        `--- Stats ---`,
        `Messages scanned: ${stats.messages} (from ${stats.sources.join(", ") || "no sources"})`,
        `Threads: ${stats.threads}`,
        `Files tracked: ${blobFiles} (ContentStore blobs)`,
        `Work sessions: ${sessionsCount}`,
        hotFiles.length > 0 ? `Hot files: ${hotFiles.join(", ")}` : null,
        lastModified ? `Last activity: ${lastModified}` : null,
        `Time saved: ${timeSavedStr}`,
        ``,
        `--- Next Steps ---`,
        `Data is indexed and queryable. Use these MCP tools for details:`,
        `  - search_context(query, {source, tag, limit}) — RAG search across all evidence`,
        `  - rl4_ask(query) — ask any question about the project`,
        `  - get_evidence — structured project facts (sessions, file activity)`,
        `  - get_timeline — narrative development history`,
        `  - get_intent_graph — file coupling and workflow patterns`,
        `  - search_chats(query) — search past conversations`,
        `  - search_cli(query) — search terminal/command history`,
        ``,
        `--- Auto-rebuilt ---`,
        `timeline.md and evidence.md were auto-regenerated from JSONL evidence.`,
        `Pure mechanical truth — zero LLM hallucination.`,
        ``,
        `--- Optional: Update skills ---`,
        `Update .cursor/rules/Rl4-Skills.mdc with AVOID/DO/CONSTRAINTS/INSIGHTS if you learned something new.`,
        ``,
        `--- Finalize ---`,
        `Call finalize_snapshot when done to clean up temporary files.`,
        ``,
        `You're all set! You saved ${timeSavedStr} re-explaining thanks to RL4.`,
    ];
    return lines.filter(l => l !== null).join("\n");
}
mcpServer.tool("run_snapshot", "Run an RL4 snapshot. Works everywhere: IDE (Cursor/VS Code) or CLI (Claude Code, Codex, Gemini CLI). Scans all available chat sources (Cursor DB, Claude Code JSONL, VS Code DB) automatically. When an IDE is running, it responds within 5s; otherwise falls back to direct DB scanning. Returns a compact summary — use search_context/rl4_ask for details.", {}, async () => {
    if (isRemoteWorkspace()) {
        return {
            content: [
                {
                    type: "text",
                    text: "Snapshot only works for workspace 'current'. Call set_workspace with workspace_id 'current' first, then run_snapshot again.",
                },
            ],
        };
    }
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    const triggerPath = resolveUnderRoot(root, ".rl4", TRIGGER_HEADLESS);
    const resultPath = resolveUnderRoot(root, ".rl4", HEADLESS_RESULT);
    // Phase 1: Try IDE (5s timeout — fast path when Cursor/VS Code is open)
    try {
        if (!fs.existsSync(rl4Dir))
            fs.mkdirSync(rl4Dir, { recursive: true });
        if (fs.existsSync(resultPath))
            fs.unlinkSync(resultPath);
        fs.writeFileSync(triggerPath, String(Date.now()), "utf8");
    }
    catch {
        /* ignore trigger write failure — CLI fallback will handle it */
    }
    const IDE_TIMEOUT_MS = 5000;
    const ideDeadline = Date.now() + IDE_TIMEOUT_MS;
    while (Date.now() < ideDeadline) {
        // nosemgrep: eval-or-dynamic-code — callback ref, not string eval
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!fs.existsSync(resultPath))
            continue;
        try {
            const raw = fs.readFileSync(resultPath, "utf8");
            const data = JSON.parse(raw);
            if (data.ok && typeof data.prompt === "string") {
                // Extract stats from the prompt text for the compact summary
                const ideStats = extractStatsFromPrompt(data.prompt);
                // Auto-rebuild timeline.md + evidence.md from JSONL
                try {
                    rebuildAll(root);
                }
                catch { /* best effort */ }
                return { content: [{ type: "text", text: formatSnapshotSummary(ideStats, root) }] };
            }
            if (data.ok === false && typeof data.error === "string") {
                return { content: [{ type: "text", text: `Snapshot failed: ${data.error}` }], isError: true };
            }
        }
        catch {
            // partial write, retry
        }
    }
    // Phase 2: CLI fallback — scan Cursor DB, Claude Code JSONL, VS Code DB directly
    try {
        const result = await buildCliSnapshot(root);
        // Write full prompt for consistency (finalize_snapshot can clean it up)
        try {
            fs.writeFileSync(resultPath, JSON.stringify({ ok: true, prompt: result.prompt }), "utf8");
        }
        catch { /* best effort */ }
        // Auto-rebuild timeline.md + evidence.md from JSONL
        try {
            rebuildAll(root);
        }
        catch { /* best effort */ }
        // Return compact summary instead of the full 76K prompt
        return { content: [{ type: "text", text: formatSnapshotSummary(result.stats, root) }] };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Snapshot failed (CLI fallback): ${msg}` }], isError: true };
    }
});
mcpServer.tool("finalize_snapshot", "Call this after you have used the snapshot context (from run_snapshot) and finalized your response. Removes the temporary file .rl4/last_final_prompt.txt and .rl4/.headless_result.json so the workspace stays clean. Only works when workspace is 'current'.", {}, async () => {
    if (isRemoteWorkspace()) {
        return {
            content: [
                {
                    type: "text",
                    text: "finalize_snapshot only works for workspace 'current'. No local .rl4/ to clean.",
                },
            ],
        };
    }
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    const promptPath = resolveUnderRoot(root, ".rl4", "last_final_prompt.txt");
    const resultPath = resolveUnderRoot(root, ".rl4", HEADLESS_RESULT);
    const removed = [];
    try {
        if (fs.existsSync(promptPath)) {
            fs.unlinkSync(promptPath);
            removed.push("last_final_prompt.txt");
        }
        if (fs.existsSync(resultPath)) {
            fs.unlinkSync(resultPath);
            removed.push(".headless_result.json");
        }
        // WS1C: Resolve all pending CRE outcomes on snapshot finalization
        let resolvedCount = 0;
        try {
            const interventionLogPath = resolveUnderRoot(root, ".rl4", ".internal", "cre_interventions.jsonl");
            const raw = readFileSafe(interventionLogPath);
            if (raw) {
                const pendingFiles = new Set();
                for (const line of raw.trim().split("\n").filter(Boolean)) {
                    try {
                        const itv = JSON.parse(line);
                        if (itv.outcome === "pending")
                            pendingFiles.add(itv.file);
                    }
                    catch { /* skip */ }
                }
                if (pendingFiles.size > 0) {
                    resolveOutcomes(root, [...pendingFiles]);
                    resolvedCount = pendingFiles.size;
                }
            }
        }
        catch { /* CRE resolution non-critical */ }
        const parts = [];
        if (removed.length > 0)
            parts.push(`Removed: ${removed.join(", ")}`);
        if (resolvedCount > 0)
            parts.push(`CRE: resolved outcomes for ${resolvedCount} pending file(s)`);
        const text = parts.length > 0
            ? `RL4: Finalized. ${parts.join(". ")}.`
            : "RL4: Nothing to remove (files already absent).";
        return { content: [{ type: "text", text }] };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `finalize_snapshot failed: ${msg}` }], isError: true };
    }
});
const FILE_INDEX_PATH = ".rl4/snapshots/file_index.json";
const SNAPSHOTS_DIR = ".rl4/snapshots";
const SHA256_HEX = /^[a-f0-9]{64}$/;
mcpServer.tool("get_content_store_index", "Return the ContentStore file index (path → checksums) from .rl4/snapshots/file_index.json. Use this to know which file path maps to which SHA-256 checksum so you can later read blobs with read_rl4_blob. Only works when workspace is 'current'. Enables reconstructing files from blobs in a virgin repo.", {}, async () => {
    if (isRemoteWorkspace()) {
        return {
            content: [{ type: "text", text: "get_content_store_index only works for workspace 'current'. No local .rl4/snapshots/." }],
        };
    }
    const filePath = resolveUnderRoot(root, ".rl4", "snapshots", "file_index.json");
    try {
        if (!fs.existsSync(filePath)) {
            return { content: [{ type: "text", text: "[No file_index.json found. Extension populates .rl4/snapshots/ when it hashes/captures files.]" }] };
        }
        const raw = fs.readFileSync(filePath, "utf8");
        JSON.parse(raw); // validate JSON before returning
        return { content: [{ type: "text", text: raw }] };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `get_content_store_index failed: ${msg}` }], isError: true };
    }
});
mcpServer.tool("read_rl4_blob", "Read the content of a ContentStore blob by SHA-256 checksum. Path: .rl4/snapshots/<checksum>.content. Use get_content_store_index first to get path → checksum mapping, then call this to retrieve file content for reconstruction. Only works when workspace is 'current'.", { checksum: z.string().describe("SHA-256 hex checksum (64 lowercase hex chars) from file_index.json") }, async (args) => {
    var _a;
    if (isRemoteWorkspace()) {
        return {
            content: [{ type: "text", text: "read_rl4_blob only works for workspace 'current'." }],
        };
    }
    const checksum = String((_a = args.checksum) !== null && _a !== void 0 ? _a : "").trim().toLowerCase();
    if (!SHA256_HEX.test(checksum)) {
        return {
            content: [{ type: "text", text: "read_rl4_blob: checksum must be 64 lowercase hex characters (SHA-256)." }],
            isError: true,
        };
    }
    const blobPath = resolveUnderRoot(root, ".rl4", "snapshots", `${checksum}.content`);
    const blobPathGz = resolveUnderRoot(root, ".rl4", "snapshots", `${checksum}.content.gz`);
    try {
        if (fs.existsSync(blobPath)) {
            const content = fs.readFileSync(blobPath, "utf8");
            return { content: [{ type: "text", text: content }] };
        }
        if (fs.existsSync(blobPathGz)) {
            const compressed = fs.readFileSync(blobPathGz);
            const content = zlib.gunzipSync(compressed).toString("utf-8");
            return { content: [{ type: "text", text: content }] };
        }
        return { content: [{ type: "text", text: `[No blob found for checksum ${checksum}.]` }] };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `read_rl4_blob failed: ${msg}` }], isError: true };
    }
});
// ── Fix #4: rl4_guardrail — validate query or response (proof-backed answers) ──
const GUARDRAIL_QUERY_MAX_LEN = 2000;
const GUARDRAIL_RESPONSE_MAX_LEN = 100000;
/** Citation pattern: file path, line ref (L42), or date (| YYYY-MM-DD) */
const CITATION_PATTERN = /\.rl4\/|L\d+| \| \d{4}-\d{2}-\d{2}/;
const GuardrailSchema = z.object({
    text: z.string().describe("Query or response text to validate"),
    type: z.enum(["query", "response"]).describe("query = user input; response = answer to validate for citations"),
    file_path: z.string().optional().describe("Optional: file being edited — triggers CRE scoring + auto-logs intervention for learning"),
});
mcpServer.tool("rl4_guardrail", "Validate a query or response against RL4 guardrails. For type=query: non-empty, max 2000 chars. For type=response: max 100000 chars and must contain at least one citation (e.g. .rl4/, L42, or | date). When file_path is provided, also runs CRE scoring and logs an intervention for learning. Returns { allowed: boolean, reason?: string, cre_intervention_id?: string }.", GuardrailSchema.shape, async (args) => {
    var _a, _b;
    const parsed = GuardrailSchema.safeParse(args);
    if (!parsed.success) {
        return {
            content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: `Invalid arguments: ${parsed.error.message}` }) }],
            isError: true,
        };
    }
    const { text, type, file_path } = parsed.data;
    const trimmed = text.trim();
    // Standard validation
    let allowed = true;
    let reason;
    if (type === "query") {
        if (trimmed.length === 0) {
            allowed = false;
            reason = "Query must not be empty.";
        }
        else if (trimmed.length > GUARDRAIL_QUERY_MAX_LEN) {
            allowed = false;
            reason = `Query exceeds ${GUARDRAIL_QUERY_MAX_LEN} characters.`;
        }
    }
    else if (type === "response") {
        if (trimmed.length > GUARDRAIL_RESPONSE_MAX_LEN) {
            allowed = false;
            reason = `Response exceeds ${GUARDRAIL_RESPONSE_MAX_LEN} characters.`;
        }
        else if (!CITATION_PATTERN.test(trimmed)) {
            allowed = false;
            reason = "Response must contain at least one citation (e.g. .rl4/ path, L42, or | date).";
        }
    }
    else {
        return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Invalid type." }) }], isError: true };
    }
    // WS1A: Auto-log CRE intervention when file_path is provided
    let creInterventionId = null;
    if (file_path && root && !isRemoteWorkspace()) {
        try {
            const relPath = String(file_path).trim();
            if (relPath) {
                // Load lessons + score via CRE (lightweight — reuses suggest_edit ctx cache)
                const lessons = loadLessonsForFile(root, relPath);
                const allLessons = fileLessonsToLessons(lessons, relPath);
                if (allLessons.length > 0) {
                    const cachedCtx = getSuggestEditCtx(root);
                    const graph = buildCouplingGraph((_b = (_a = cachedCtx.intentGraph) === null || _a === void 0 ? void 0 : _a.coupling) !== null && _b !== void 0 ? _b : [], cachedCtx.causalLinks, cachedCtx.burstSessions);
                    const avgDays = computeAvgDaysBetweenSaves(root, relPath);
                    const scoringCtx = {
                        graph, state: cachedCtx.creState, targetFile: relPath,
                        avgDaysBetweenSaves: avgDays, now: Date.now(),
                    };
                    const scored = scoreLessons(allLessons, scoringCtx);
                    const selection = selectSubmodular(scored);
                    if (selection.selected.length > 0) {
                        creInterventionId = logIntervention(root, relPath, selection);
                        // Also cache for apply_edit (in case agent follows up)
                        lastCRESelection = { file: relPath, result: selection, timestamp: new Date().toISOString() };
                    }
                }
            }
        }
        catch { /* CRE auto-log is non-critical — guardrail still works */ }
    }
    const result = { allowed };
    if (reason)
        result.reason = reason;
    if (creInterventionId)
        result.cre_intervention_id = creInterventionId;
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
// ── CRE — Causal Relevance Engine integration ───────────────────────────────
/** Cache last CRE selection for apply_edit to log intervention */
let lastCRESelection = null;
/** Convert FileLessons to Lesson[] for CRE scoring */
function fileLessonsToLessons(fl, relPath) {
    const lessons = [];
    const now = new Date().toISOString();
    for (const avoid of fl.avoid_patterns) {
        lessons.push({
            id: stableLessonId("AVOID", relPath, avoid),
            type: "AVOID",
            text: avoid,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["skills.mdc"],
            first_seen: now,
            last_seen: now,
        });
    }
    for (const rev of fl.reversals) {
        const text = `Reversal v${rev.from_v}→v${rev.to_v}: ${rev.reverted_lines} lines reverted (${rev.time_gap_hours.toFixed(1)}h gap)`;
        lessons.push({
            id: stableLessonId("REVERSAL", relPath, text),
            type: "REVERSAL",
            text,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["intent_graph.json"],
            first_seen: now,
            last_seen: now,
        });
    }
    for (const coupled of fl.coupled_files) {
        const text = `Coupled with ${coupled} — changes here may require changes there`;
        lessons.push({
            id: stableLessonId("COUPLING", relPath, text),
            type: "COUPLING",
            text,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["intent_graph.json:coupling"],
            first_seen: now,
            last_seen: now,
        });
    }
    for (const dec of fl.past_decisions) {
        lessons.push({
            id: stableLessonId("DECISION", relPath, dec),
            type: "DECISION",
            text: dec,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["decisions.jsonl"],
            first_seen: now,
            last_seen: now,
        });
    }
    if (fl.hot_score > 0.5) {
        const text = `Hot file (score: ${fl.hot_score.toFixed(2)}, trajectory: ${fl.trajectory})`;
        lessons.push({
            id: stableLessonId("HOTSPOT", relPath, text),
            type: "HOTSPOT",
            text,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["intent_graph.json"],
            first_seen: now,
            last_seen: now,
        });
    }
    for (const chat of fl.chat_lessons) {
        lessons.push({
            id: stableLessonId("CHAT", relPath, chat),
            type: "CHAT",
            text: chat,
            origin_file: relPath,
            origin_prompt_ids: [],
            evidence_refs: ["chat_history.jsonl"],
            first_seen: now,
            last_seen: now,
        });
    }
    return lessons;
}
let _suggestEditCtxCache = null;
const SUGGEST_EDIT_CTX_TTL_MS = 60000;
function getSuggestEditCtx(root) {
    const now = Date.now();
    // Check TTL
    if (_suggestEditCtxCache && (now - _suggestEditCtxCache.ts < SUGGEST_EDIT_CTX_TTL_MS)) {
        // Also check mtimes of source files
        let stale = false;
        for (const [p, cachedMtime] of Object.entries(_suggestEditCtxCache.mtimes)) {
            try {
                const currentMtime = fs.statSync(p).mtimeMs;
                if (currentMtime !== cachedMtime) {
                    stale = true;
                    break;
                }
            }
            catch {
                stale = true;
                break;
            }
        }
        if (!stale)
            return _suggestEditCtxCache.data;
    }
    // Cache miss or stale — reload
    const paths = {
        creState: resolveUnderRoot(root, ".rl4", ".internal", "cre_state.json"),
        intentGraph: resolveUnderRoot(root, ".rl4", "snapshots", "intent_graph.json"),
        causalLinks: resolveUnderRoot(root, ".rl4", "evidence", "causal_links.jsonl"),
        burstSessions: resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl"),
    };
    const mtimes = {};
    for (const [, p] of Object.entries(paths)) {
        try {
            mtimes[p] = fs.statSync(p).mtimeMs;
        }
        catch {
            mtimes[p] = 0;
        }
    }
    const data = {
        creState: loadCREState(root),
        intentGraph: readIntentGraphData(root),
        causalLinks: readCausalLinks(root),
        burstSessions: readBurstSessions(root),
    };
    _suggestEditCtxCache = { data, ts: now, mtimes };
    return data;
}
const AGENT_RATE_LIMIT = new Map();
function checkRateLimit(tool, maxPerMin) {
    var _a;
    const now = Date.now();
    const window = 60000;
    const calls = (_a = AGENT_RATE_LIMIT.get(tool)) !== null && _a !== void 0 ? _a : [];
    const recent = calls.filter((t) => now - t < window);
    if (recent.length >= maxPerMin)
        return false;
    recent.push(now);
    AGENT_RATE_LIMIT.set(tool, recent);
    return true;
}
mcpServer.tool("suggest_edit", "IMPORTANT: Always call this before editing any file. Returns file content + lessons from past mistakes (reversals, AVOID patterns, coupled files, team activity). Prevents repeating errors. The agent SHOULD call this automatically before any file modification.", {
    file_path: z.string().describe("Relative path to the file from workspace root"),
    intent: z.string().optional().describe("What you intend to do with the file (helps filter relevant lessons)"),
}, async (args) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    if (isRemoteWorkspace()) {
        return { content: [{ type: "text", text: "suggest_edit only works for workspace 'current'." }] };
    }
    const relPath = String((_a = args.file_path) !== null && _a !== void 0 ? _a : "").trim();
    if (!relPath) {
        return { content: [{ type: "text", text: "suggest_edit: file_path is required." }], isError: true };
    }
    const absPath = resolveUnderRoot(root, relPath);
    // 0. CRE — resolve pending outcomes for this file (opportunistic)
    try {
        resolveOutcomes(root, [relPath]);
    }
    catch { /* non-critical */ }
    // 1. Read file content
    const content = (_b = readFileSafe(absPath)) !== null && _b !== void 0 ? _b : "[File not found]";
    // 2. Load lessons from intent graph, skills.mdc, decisions
    const lessons = loadLessonsForFile(root, relPath);
    // 3. Search chat history for lessons (via RAG if available)
    const intent = String((_c = args.intent) !== null && _c !== void 0 ? _c : "");
    if (intent) {
        try {
            const chatHistoryPath = resolveUnderRoot(root, ".rl4", "evidence", "chat_history.jsonl");
            if (fs.existsSync(chatHistoryPath)) {
                const chatRaw = fs.readFileSync(chatHistoryPath, "utf-8");
                const chatLines = chatRaw.split("\n").filter(Boolean).slice(-200); // last 200 messages
                for (const line of chatLines) {
                    try {
                        const msg = JSON.parse(line);
                        const text = String((_e = (_d = msg.content) !== null && _d !== void 0 ? _d : msg.text) !== null && _e !== void 0 ? _e : "").toLowerCase();
                        if (text.includes(relPath.toLowerCase()) || (intent && text.includes(intent.toLowerCase()))) {
                            const snippet = String((_g = (_f = msg.content) !== null && _f !== void 0 ? _f : msg.text) !== null && _g !== void 0 ? _g : "").slice(0, 200);
                            if (snippet.length > 20)
                                lessons.chat_lessons.push(snippet);
                        }
                    }
                    catch { /* skip */ }
                }
                // Dedupe and limit
                lessons.chat_lessons = [...new Set(lessons.chat_lessons)].slice(0, 5);
            }
        }
        catch { /* chat search optional */ }
    }
    // 3b. Team context — full multi-workspace lesson merge (read-only)
    // Fetch teammate workspaces, extract their lessons for the same file,
    // merge into CRE candidates with source_workspace_id for traceability.
    // Learning (Beta-Binomial) stays local — only retrieval is multi-user.
    const teamLessons = [];
    const teamCouplingPairs = [];
    try {
        const teammates = await listRepoTeammatesFromSupabase();
        if (teammates.length > 0) {
            // Fetch up to 3 teammates in parallel (limit latency)
            const tmContexts = await Promise.all(teammates.slice(0, 3).map(async (tm) => {
                try {
                    const ctx = await fetchWorkspaceContextFromSupabase(tm.workspace_id);
                    return { tm, ctx };
                }
                catch {
                    return null;
                }
            }));
            const now = new Date().toISOString();
            for (const item of tmContexts) {
                if (!item)
                    continue;
                const { tm, ctx } = item;
                const wsTag = `team:${tm.workspace_id}`;
                // A. Parse teammate's intent_graph → reversals, hot_score, coupling, trajectory
                if (ctx.intent_graph && !ctx.intent_graph.startsWith("[")) {
                    try {
                        const igText = ctx.intent_graph.replace(/^Source:.*\n\n/, "");
                        const igData = JSON.parse(igText);
                        // Extract file-specific lessons from teammate's chains
                        const chains = (igData === null || igData === void 0 ? void 0 : igData.chains) || [];
                        const fileMatch = chains.find((c) => { var _a; return c.file === relPath || ((_a = c.file) === null || _a === void 0 ? void 0 : _a.endsWith("/" + relPath)); });
                        if (fileMatch) {
                            // Teammate activity warning
                            teamLessons.push({
                                id: stableLessonId("COUPLING", relPath, `team-activity-${tm.workspace_id}`),
                                type: "COUPLING",
                                text: `Teammate ${tm.owner_email} has activity on this file (${fileMatch.versions || "?"} versions, trajectory: ${fileMatch.trajectory || "unknown"}). Check via set_workspace("${tm.workspace_id}").`,
                                origin_file: relPath,
                                origin_prompt_ids: [],
                                evidence_refs: [wsTag],
                                first_seen: now, last_seen: now,
                                source_workspace_id: tm.workspace_id,
                            });
                            // Teammate reversals → REVERSAL lessons
                            if (fileMatch.last_reversal && typeof fileMatch.last_reversal === "object") {
                                const rev = fileMatch.last_reversal;
                                const revText = `[Team] Reversal on ${relPath} by ${tm.owner_email}: v${rev.from_v}→v${rev.to_v}, ${rev.reverted_lines} lines (${Number(rev.time_gap_hours || 0).toFixed(1)}h gap)`;
                                teamLessons.push({
                                    id: stableLessonId("REVERSAL", relPath, revText),
                                    type: "REVERSAL",
                                    text: revText,
                                    origin_file: relPath,
                                    origin_prompt_ids: [],
                                    evidence_refs: [wsTag, "intent_graph.json"],
                                    first_seen: now, last_seen: now,
                                    source_workspace_id: tm.workspace_id,
                                });
                            }
                            // Teammate hot file → HOTSPOT lesson
                            if (typeof fileMatch.hot_score === "number" && fileMatch.hot_score > 0.5) {
                                const hotText = `[Team] Hot file for ${tm.owner_email} (score: ${fileMatch.hot_score.toFixed(2)}, trajectory: ${fileMatch.trajectory})`;
                                teamLessons.push({
                                    id: stableLessonId("HOTSPOT", relPath, hotText),
                                    type: "HOTSPOT",
                                    text: hotText,
                                    origin_file: relPath,
                                    origin_prompt_ids: [],
                                    evidence_refs: [wsTag],
                                    first_seen: now, last_seen: now,
                                    source_workspace_id: tm.workspace_id,
                                });
                            }
                        }
                        // Extract teammate coupling edges → enrich the graph
                        const tmCoupling = (igData === null || igData === void 0 ? void 0 : igData.coupling) || [];
                        for (const cp of tmCoupling) {
                            if (((_h = cp.files) === null || _h === void 0 ? void 0 : _h.length) >= 2) {
                                teamCouplingPairs.push(cp);
                            }
                        }
                    }
                    catch { /* teammate intent_graph parse non-critical */ }
                }
                // B. Parse teammate's evidence → AVOID patterns for this file
                if (ctx.evidence && !ctx.evidence.startsWith("[")) {
                    try {
                        const evidenceText = ctx.evidence;
                        const lines = evidenceText.split("\n");
                        for (const line of lines) {
                            if (line.includes("AVOID") && (line.includes(relPath) || line.toLowerCase().includes("avoid:"))) {
                                const avoidText = `[Team:${tm.owner_email}] ${line.replace(/^-\s*/, "").trim()}`;
                                teamLessons.push({
                                    id: stableLessonId("AVOID", relPath, avoidText),
                                    type: "AVOID",
                                    text: avoidText,
                                    origin_file: relPath,
                                    origin_prompt_ids: [],
                                    evidence_refs: [wsTag, "evidence.md"],
                                    first_seen: now, last_seen: now,
                                    source_workspace_id: tm.workspace_id,
                                });
                            }
                        }
                    }
                    catch { /* evidence parse non-critical */ }
                }
                // C. Parse teammate's decisions → DECISION lessons for this file
                if (ctx.decisions && !ctx.decisions.startsWith("[")) {
                    try {
                        const decText = ctx.decisions;
                        const lines = decText.split("\n").filter((l) => l.startsWith("- ["));
                        for (const line of lines) {
                            if (line.includes(relPath)) {
                                const decContent = `[Team:${tm.owner_email}] ${line.replace(/^-\s*/, "").trim()}`;
                                teamLessons.push({
                                    id: stableLessonId("DECISION", relPath, decContent),
                                    type: "DECISION",
                                    text: decContent,
                                    origin_file: relPath,
                                    origin_prompt_ids: [],
                                    evidence_refs: [wsTag, "decisions.jsonl"],
                                    first_seen: now, last_seen: now,
                                    source_workspace_id: tm.workspace_id,
                                });
                            }
                        }
                    }
                    catch { /* decisions parse non-critical */ }
                }
            }
        }
    }
    catch { /* team merge is non-critical — local CRE still works */ }
    // 4. CRE — score and select lessons under token budget (cached: TTL 60s + mtime)
    const cachedCtx = getSuggestEditCtx(root);
    const creState = cachedCtx.creState;
    const intentGraphData = cachedCtx.intentGraph;
    const causalLinks = cachedCtx.causalLinks;
    const burstSessions = cachedCtx.burstSessions;
    // Merge local + team coupling pairs for enriched graph
    const localCouplingPairs = (_j = intentGraphData === null || intentGraphData === void 0 ? void 0 : intentGraphData.coupling) !== null && _j !== void 0 ? _j : [];
    const allCouplingPairs = [...localCouplingPairs, ...teamCouplingPairs];
    const graph = buildCouplingGraph(allCouplingPairs, causalLinks, burstSessions);
    const avgDays = computeAvgDaysBetweenSaves(root, relPath);
    // Merge local + team lessons
    const allLessons = [...fileLessonsToLessons(lessons, relPath), ...teamLessons];
    const scoringCtx = {
        graph,
        state: creState,
        targetFile: relPath,
        avgDaysBetweenSaves: avgDays,
        now: Date.now(),
    };
    // V2: Try SWITCH-DR weight adaptation if gate is met
    let adaptedWeights = null;
    let v2Active = false;
    if (creState && creState.safety.total_interventions >= CRE_PARAMS.V2_GATE) {
        try {
            const allInterventions = readAllInterventions(root);
            const drResult = switchDREstimate(allInterventions);
            if (drResult) {
                adaptedWeights = drResult.weights;
                v2Active = true;
                // Persist adapted weights to CRE state
                if (creState) {
                    creState.weights = drResult.weights;
                    creState.v2_gate_met = true;
                    creState.v2_activated_at = (_k = creState.v2_activated_at) !== null && _k !== void 0 ? _k : new Date().toISOString();
                    creState.switch_dr_last_estimate = new Date().toISOString();
                }
            }
        }
        catch { /* V2 is non-critical — falls back to V1 fixed weights */ }
    }
    const scored = v2Active
        ? scoreLessonsAdapted(allLessons, scoringCtx, adaptedWeights)
        : scoreLessons(allLessons, scoringCtx);
    const selection = selectSubmodular(scored);
    // Cache for apply_edit intervention logging (in-memory)
    lastCRESelection = { file: relPath, result: selection, timestamp: new Date().toISOString() };
    // 5. Build response with CRE debug info
    const selectedTexts = scored
        .filter(s => selection.selected.some(sel => sel.id === s.lesson.id))
        .map(s => ({
        type: s.lesson.type,
        text: s.lesson.text,
        score: s.crs_score,
        source: s.lesson.source_workspace_id ? `team:${s.lesson.source_workspace_id}` : "local",
    }));
    // Persist suggestion to disk for Claude Code hooks (PreToolUse reads this)
    try {
        const hookCachePath = resolveUnderRoot(root, ".rl4", ".internal", "cre_last_suggestion.json");
        const hookCacheDir = path.dirname(hookCachePath);
        if (!fs.existsSync(hookCacheDir))
            fs.mkdirSync(hookCacheDir, { recursive: true });
        fs.writeFileSync(hookCachePath, JSON.stringify({
            file: relPath,
            timestamp: new Date().toISOString(),
            lessons: selectedTexts,
            selected_count: selection.selected.length,
            candidate_count: selection.candidates.length,
        }, null, 2));
    }
    catch { /* non-blocking */ }
    const teamLessonCount = teamLessons.length;
    const response = {
        content: content.length > 50000 ? content.slice(0, 50000) + "\n[...truncated]" : content,
        lessons: selectedTexts.length > 0 ? selectedTexts : lessons, // fallback to raw lessons if CRE has none
        file_path: relPath,
        cre: {
            version: v2Active ? "2.0.0" : "1.1.0",
            v2_active: v2Active,
            adapted_weights: adaptedWeights,
            selected_count: selection.selected.length,
            candidate_count: selection.candidates.length,
            team_lessons_merged: teamLessonCount,
            team_coupling_edges: teamCouplingPairs.length,
            budget: { used: selection.used_tokens, total: selection.budget_tokens },
            scores: selection.selected.map(s => {
                var _a, _b;
                return ({
                    id: s.id,
                    type: s.type,
                    crs: s.crs_score.toFixed(3),
                    source: ((_a = allLessons.find(l => l.id === s.id)) === null || _a === void 0 ? void 0 : _a.source_workspace_id)
                        ? `team:${(_b = allLessons.find(l => l.id === s.id)) === null || _b === void 0 ? void 0 : _b.source_workspace_id}`
                        : "local",
                    breakdown: {
                        proximity: s.score_breakdown.causal_proximity.toFixed(3),
                        counterfactual: s.score_breakdown.counterfactual.toFixed(3),
                        temporal: s.score_breakdown.temporal.toFixed(3),
                        info_gain: s.score_breakdown.info_gain.toFixed(3),
                    },
                });
            }),
        },
    };
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
});
mcpServer.tool("apply_edit", "Write file content with SHA-256 backup and proof chain. Use after suggest_edit to apply changes. Automatically backs up the previous version and logs the action.", {
    file_path: z.string().describe("Relative path to the file from workspace root"),
    content: z.string().describe("New file content to write"),
    description: z.string().describe("Short description of the change"),
}, async (args) => {
    var _a, _b, _c;
    if (isRemoteWorkspace()) {
        return { content: [{ type: "text", text: "apply_edit only works for workspace 'current'." }] };
    }
    if (!checkRateLimit("apply_edit", 30)) {
        return { content: [{ type: "text", text: "apply_edit: rate limit exceeded (30/min)." }], isError: true };
    }
    const relPath = String((_a = args.file_path) !== null && _a !== void 0 ? _a : "").trim();
    const newContent = String((_b = args.content) !== null && _b !== void 0 ? _b : "");
    const description = String((_c = args.description) !== null && _c !== void 0 ? _c : "");
    if (!relPath || !newContent) {
        return { content: [{ type: "text", text: "apply_edit: file_path and content are required." }], isError: true };
    }
    const absPath = resolveUnderRoot(root, relPath);
    try {
        // 1. Backup current version in .rl4/snapshots/
        let backupChecksum = "";
        if (fs.existsSync(absPath)) {
            const oldContent = fs.readFileSync(absPath, "utf-8");
            backupChecksum = crypto.createHash("sha256").update(oldContent).digest("hex");
            const snapshotsDir = resolveUnderRoot(root, ".rl4", "snapshots");
            if (!fs.existsSync(snapshotsDir))
                fs.mkdirSync(snapshotsDir, { recursive: true });
            const backupPath = path.join(snapshotsDir, `${backupChecksum}.content`);
            if (!fs.existsSync(backupPath)) {
                fs.writeFileSync(backupPath, oldContent);
            }
        }
        // 2. Write new content
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, newContent);
        // 3. Log action
        appendAgentAction(root, {
            timestamp: new Date().toISOString(),
            tool: "apply_edit",
            file: relPath,
            description,
            checksum: backupChecksum,
            result: "ok",
        });
        // 4. CRE — Log intervention if we have a cached selection for this file
        let interventionId = null;
        if (lastCRESelection && lastCRESelection.file === relPath) {
            const cacheAgeMs = Date.now() - new Date(lastCRESelection.timestamp).getTime();
            if (cacheAgeMs <= 30000) { // 30s TTL — prevent phantom interventions from stale cache
                interventionId = logIntervention(root, relPath, lastCRESelection.result);
            }
            lastCRESelection = null; // always consume, even if stale
        }
        // 5. CRE — Resolve pending outcomes for this file
        resolveOutcomes(root, [relPath]);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        ok: true,
                        backup_checksum: backupChecksum || null,
                        file: relPath,
                        cre_intervention_id: interventionId,
                    }),
                }],
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendAgentAction(root, {
            timestamp: new Date().toISOString(),
            tool: "apply_edit",
            file: relPath,
            description,
            result: "error",
            error_message: msg,
        });
        return { content: [{ type: "text", text: `apply_edit failed: ${msg}` }], isError: true };
    }
});
const COMMAND_BLOCKLIST = ["rm -rf /", "sudo rm", "format", "mkfs", "dd if="];
const MAX_OUTPUT = 50000;
mcpServer.tool("run_command", "Execute a shell command safely (execFile, no shell injection). Logs to agent_actions.jsonl. Use for build, test, lint, git commands. Blocklisted: destructive system commands.", {
    command: z.string().describe("The command to execute (e.g. 'npm', 'git', 'node')"),
    args: z.array(z.string()).optional().describe("Command arguments"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default 60000, max 120000)"),
}, async (args) => {
    var _a, _b;
    if (isRemoteWorkspace()) {
        return { content: [{ type: "text", text: "run_command only works for workspace 'current'." }] };
    }
    if (!checkRateLimit("run_command", 20)) {
        return { content: [{ type: "text", text: "run_command: rate limit exceeded (20/min)." }], isError: true };
    }
    const command = String((_a = args.command) !== null && _a !== void 0 ? _a : "").trim();
    const cmdArgs = ((_b = args.args) !== null && _b !== void 0 ? _b : []).map(String);
    const timeout = Math.min(Number(args.timeout_ms) || 60000, 120000);
    if (!command) {
        return { content: [{ type: "text", text: "run_command: command is required." }], isError: true };
    }
    // Blocklist check
    const fullCmd = `${command} ${cmdArgs.join(" ")}`;
    for (const blocked of COMMAND_BLOCKLIST) {
        if (fullCmd.toLowerCase().includes(blocked.toLowerCase())) {
            return { content: [{ type: "text", text: `run_command: blocked command pattern "${blocked}".` }], isError: true };
        }
    }
    try {
        const result = await new Promise((resolve) => {
            const proc = execFile(command, cmdArgs, { cwd: root, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
                var _a;
                resolve({
                    stdout: String(stdout !== null && stdout !== void 0 ? stdout : "").slice(0, MAX_OUTPUT),
                    stderr: String(stderr !== null && stderr !== void 0 ? stderr : "").slice(0, MAX_OUTPUT),
                    code: err ? (_a = err.code) !== null && _a !== void 0 ? _a : 1 : 0,
                });
            });
        });
        appendAgentAction(root, {
            timestamp: new Date().toISOString(),
            tool: "run_command",
            description: fullCmd,
            result: result.code === 0 ? "ok" : "error",
            error_message: result.code !== 0 ? result.stderr.slice(0, 500) : undefined,
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ exit_code: result.code, stdout: result.stdout, stderr: result.stderr }),
                }],
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendAgentAction(root, {
            timestamp: new Date().toISOString(),
            tool: "run_command",
            description: fullCmd,
            result: "error",
            error_message: msg,
        });
        return { content: [{ type: "text", text: `run_command failed: ${msg}` }], isError: true };
    }
});
// ── deep_context — Aggregated briefing for agent deep mode ─────────────────
mcpServer.tool("deep_context", "Get a comprehensive briefing for a set of files before editing. Returns per-file lessons, reversals, hot_score, trajectory, AVOID patterns, coupled files, CRE state summary, recent timeline entries, and coupling graph neighborhood. Use this in agent deep mode before any file modification to prevent errors.", {
    files: z.array(z.string()).describe("Relative file paths from workspace root"),
    intent: z.string().optional().describe("What you intend to do (helps filter relevant context)"),
}, async (args) => {
    var _a, _b, _c, _d, _e;
    if (isRemoteWorkspace()) {
        return { content: [{ type: "text", text: "deep_context only works for workspace 'current'." }] };
    }
    const files = ((_a = args.files) !== null && _a !== void 0 ? _a : []).map(String).filter(Boolean);
    const intent = String((_b = args.intent) !== null && _b !== void 0 ? _b : "");
    if (files.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "files array is required and must not be empty." }) }], isError: true };
    }
    const cachedCtx = getSuggestEditCtx(root);
    const creState = cachedCtx.creState;
    const graph = buildCouplingGraph((_d = (_c = cachedCtx.intentGraph) === null || _c === void 0 ? void 0 : _c.coupling) !== null && _d !== void 0 ? _d : [], cachedCtx.causalLinks, cachedCtx.burstSessions);
    // Per-file briefing
    const perFile = {};
    const allAvoidPatterns = [];
    for (const relPath of files) {
        const fl = loadLessonsForFile(root, relPath);
        const lessons = fileLessonsToLessons(fl, relPath);
        const avgDays = computeAvgDaysBetweenSaves(root, relPath);
        const scoringCtx = {
            graph, state: creState, targetFile: relPath,
            avgDaysBetweenSaves: avgDays, now: Date.now(),
        };
        const scored = scoreLessons(lessons, scoringCtx);
        const selection = selectSubmodular(scored);
        // Collect AVOID patterns
        for (const avoid of fl.avoid_patterns)
            allAvoidPatterns.push(`[${relPath}] ${avoid}`);
        perFile[relPath] = {
            lessons_count: lessons.length,
            selected_count: selection.selected.length,
            top_lessons: selection.selected.map(s => ({
                id: s.id, type: s.type, crs: s.crs_score.toFixed(3),
            })),
            reversals: fl.reversals.map(r => ({
                from_v: r.from_v, to_v: r.to_v,
                reverted_lines: r.reverted_lines,
                time_gap_hours: r.time_gap_hours.toFixed(1),
            })),
            hot_score: fl.hot_score,
            trajectory: fl.trajectory,
            coupled_files: fl.coupled_files,
            past_decisions: fl.past_decisions.slice(0, 3),
            avoid_patterns: fl.avoid_patterns,
        };
    }
    // Global AVOID from skills.mdc
    try {
        const skillsPath = resolveUnderRoot(root, ".rl4", "skills.mdc");
        const skillsRaw = readFileSafe(skillsPath);
        if (skillsRaw) {
            const lines = skillsRaw.split("\n");
            for (const line of lines) {
                if (line.includes("AVOID") || line.includes("NEVER") || line.includes("DO NOT")) {
                    allAvoidPatterns.push(`[skills.mdc] ${line.trim()}`);
                }
            }
        }
    }
    catch { /* non-critical */ }
    // Recent timeline entries mentioning these files
    const timelineEntries = [];
    try {
        const timelineRaw = readTimeline(root);
        if (timelineRaw) {
            const lines = timelineRaw.split("\n");
            const relevant = lines.filter(l => files.some(f => l.includes(f))).slice(-20);
            timelineEntries.push(...relevant);
        }
    }
    catch { /* non-critical */ }
    // Recent interventions for these files
    let recentInterventions = 0;
    try {
        const allInterventions = readAllInterventions(root);
        recentInterventions = allInterventions.filter(i => files.includes(i.file)).length;
    }
    catch { /* non-critical */ }
    // CRE state summary
    const creSummary = creState ? {
        total_interventions: creState.safety.total_interventions,
        total_reversed_fast: creState.safety.total_reversed_fast,
        total_reworked: creState.safety.total_reworked,
        v2_active: (_e = creState.v2_gate_met) !== null && _e !== void 0 ? _e : false,
        weights: creState.weights,
        frozen: creState.safety.frozen,
        bypass_rate: creState.kpis.bypass_rate,
        efficacy: creState.kpis.efficacy_per_lesson,
    } : null;
    const briefing = {
        deep_context_version: "1.0.0",
        files_analyzed: files.length,
        intent: intent || null,
        per_file: perFile,
        global: {
            avoid_patterns: [...new Set(allAvoidPatterns)],
            cre_summary: creSummary,
            recent_interventions_for_files: recentInterventions,
            timeline_mentions: timelineEntries.length,
        },
        timeline_recent: timelineEntries.slice(-10),
        hard_constraints: allAvoidPatterns.filter(p => p.toLowerCase().includes("never") || p.toLowerCase().includes("do not") || p.toLowerCase().includes("avoid")),
    };
    return { content: [{ type: "text", text: JSON.stringify(briefing, null, 2) }] };
});
async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    // Log to stderr so we don't break stdio
    console.error("[RL4 MCP] Server running. Workspace root:", root);
    // Warm up RAG engine in background (non-blocking) so first query is instant
    setImmediate(() => {
        try {
            const w = warmUpEngine(root);
            console.error(`[RL4 MCP] Engine warm-up: ${w.chunks} chunks indexed in ${w.timeMs}ms`);
        }
        catch (e) {
            console.error("[RL4 MCP] Engine warm-up failed (non-fatal):", e === null || e === void 0 ? void 0 : e.message);
        }
    });
}
main().catch((err) => {
    console.error("[RL4 MCP] Fatal:", err);
    process.exit(1);
});
