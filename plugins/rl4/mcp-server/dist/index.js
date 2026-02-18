#!/usr/bin/env node
/**
 * RL4 MCP Server — evidence, timeline, decisions, search_context.
 * Bound to user UUID (RL4_USER_ID) and workspace (RL4_WORKSPACE_ROOT or set_workspace).
 * list_workspaces from Supabase; set_workspace to choose; get_* use .rl4/ local or Supabase when workspace !== "current".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getWorkspaceRoot, readEvidence, readTimeline, readDecisions, formatDecisionsForResource, readIntentGraph, } from "./workspace.js";
import { searchContext } from "./search.js";
import { ask } from "./ask.js";
import { resolveUnderRoot } from "./safePath.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
const root = getWorkspaceRoot();
// Validate workspace root exists at startup
if (root && !fs.existsSync(root)) {
    console.error(`[RL4 MCP] Warning: workspace root does not exist: ${root}`);
}
if (root) {
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    if (!fs.existsSync(rl4Dir)) {
        try {
            fs.mkdirSync(rl4Dir, { recursive: true });
            console.error(`[RL4 MCP] Created .rl4/ at ${rl4Dir}`);
        }
        catch {
            console.error(`[RL4 MCP] Warning: could not create .rl4/ at ${rl4Dir}`);
        }
    }
}
const TRIGGER_HEADLESS = ".trigger_headless_snapshot";
const HEADLESS_RESULT = ".headless_result.json";
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 90000; // 90s — no timeout accepted; extension may need time to wake
// Session: selected workspace (from set_workspace). "current" = use root; other = Supabase fetch.
let selectedWorkspaceId = null;
/** Load SUPABASE_URL, SUPABASE_ANON_KEY, RL4_ACCESS_TOKEN from ~/.rl4/mcp.env (written by extension on Connect). Enables MCP to work when invoked from another workspace that has no mcp.json. */
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
        };
    }
    catch {
        return {};
    }
}
/** Supabase config: always prefer ~/.rl4/mcp.env when present (extension writes fresh token on Connect/activation). Avoids 401 after Reload when Cursor started MCP with stale env. */
function getSupabaseConfig() {
    const fromFile = loadSupabaseFromGlobalFile();
    const url = fromFile.supabaseUrl || process.env.SUPABASE_URL || "";
    const anon = fromFile.supabaseAnon || process.env.SUPABASE_ANON_KEY || "";
    const token = fromFile.accessToken || process.env.RL4_ACCESS_TOKEN || "";
    if (url && anon && token)
        return { supabaseUrl: url, supabaseAnon: anon, accessToken: token };
    return null;
}
function isRemoteWorkspace() {
    return selectedWorkspaceId != null && selectedWorkspaceId !== "current";
}
function getEffectiveRoot() {
    return isRemoteWorkspace() ? "" : root;
}
let workspaceContextCache = null;
async function fetchWorkspaceContextFromSupabase(workspaceId) {
    var _a, _b;
    const cfg = getSupabaseConfig();
    const err = "[Supabase not configured. Set SUPABASE_URL and RL4_ACCESS_TOKEN, or run RL4: Connect from any workspace.]";
    const err401 = " Token expired. Run RL4: Connect + Reload Window. Fallback: read .rl4/evidence.md from current folder via Read tool.";
    if (!cfg)
        return { evidence: err, timeline: err, decisions: err, intent_graph: err };
    try {
        const controller = new AbortController();
        // nosemgrep: eval-or-dynamic-code — callback ref, not string eval
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/get_rl4_workspace_context`, {
            method: "POST",
            headers: {
                apikey: cfg.supabaseAnon,
                Authorization: `Bearer ${cfg.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_workspace_id: workspaceId }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const base = `[Supabase error ${res.status}.]`;
            const msg = res.status === 401 ? base + err401 : base;
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
async function fetchDecisionsFromSupabase(workspaceId) {
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) === workspaceId)
        return workspaceContextCache.data.decisions;
    const data = await fetchWorkspaceContextFromSupabase(workspaceId);
    workspaceContextCache = { workspaceId, data };
    return data.decisions;
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
mcpServer.resource("decisions", "rl4://workspace/decisions", { description: "RL4 decisions — list/summary of decisions (intent, chosen_option, confidence_gate)" }, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchDecisionsFromSupabase(selectedWorkspaceId)
        : formatDecisionsForResource(readDecisions(root));
    return {
        contents: [{ uri: "rl4://workspace/decisions", mimeType: "text/plain", text }],
    };
});
mcpServer.resource("intent_graph", "rl4://workspace/intent_graph", { description: "RL4 MIG intent_graph.json — aggregated intent graph (chains, trajectories, hot scores)" }, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchIntentGraphFromSupabase(selectedWorkspaceId)
        : readIntentGraph(root);
    return {
        contents: [{ uri: "rl4://workspace/intent_graph", mimeType: "application/json", text }],
    };
});
// --- Tools ---
mcpServer.tool("get_evidence", "Return RL4 evidence (facts, sessions, activity). Source: .rl4/evidence.md when workspace is 'current', else Supabase rl4_workspace_evidence.", {}, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchEvidenceFromSupabase(selectedWorkspaceId)
        : readEvidence(root);
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("get_timeline", "Return RL4 timeline (developer journal). Source: .rl4/timeline.md when workspace is 'current', else Supabase rl4_workspace_timeline.", {}, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchTimelineFromSupabase(selectedWorkspaceId)
        : readTimeline(root);
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("get_decisions", "Return list/summary of RL4 decisions (intent, chosen_option, confidence_gate). Source: local decisions.jsonl when workspace is 'current', else Supabase rl4_workspace_decisions.", {}, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchDecisionsFromSupabase(selectedWorkspaceId)
        : formatDecisionsForResource(readDecisions(root));
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("get_intent_graph", "Return RL4 MIG intent_graph (chains, trajectories, hot scores). Source: .rl4/intent_graph.json when workspace is 'current', else Supabase rl4_workspace_intent_graph.", {}, async () => {
    const text = isRemoteWorkspace() && selectedWorkspaceId
        ? await fetchIntentGraphFromSupabase(selectedWorkspaceId)
        : readIntentGraph(root);
    return { content: [{ type: "text", text }] };
});
// --- RL4 Connect: list workspaces (Supabase), set workspace ---
async function listWorkspacesFromSupabase() {
    const cfg = getSupabaseConfig();
    if (!cfg)
        return { workspaces: [] };
    try {
        const controller = new AbortController();
        // nosemgrep: eval-or-dynamic-code — callback ref, not string eval
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/user_workspaces?select=workspace_id,workspace_name,snapshot_count,last_active_at&order=last_active_at.desc`, {
            headers: {
                apikey: cfg.supabaseAnon,
                Authorization: `Bearer ${cfg.accessToken}`,
                "Content-Type": "application/json",
            },
            signal: controller.signal,
        });
        clearTimeout(timeout);
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
mcpServer.tool("list_workspaces", "List workspaces for the current user (from Supabase). Call this when user says /RL4 or 'Use RL4' so they can choose a workspace. Returns workspace_id, workspace_name, snapshot_count, last_active_at.", {}, async () => {
    var _a;
    const hasSupabase = !!getSupabaseConfig();
    const { workspaces, authError } = await listWorkspacesFromSupabase();
    const currentName = root ? (_a = root.split(/[/\\]/).filter(Boolean).pop()) !== null && _a !== void 0 ? _a : "current" : "current";
    let text;
    if (workspaces.length > 0) {
        const sameAsSupabase = workspaces.some((w) => w.workspace_name === currentName);
        const currentLine = sameAsSupabase
            ? `**Current folder**: "${currentName}" — same project as a workspace above. Use set_workspace("current") for local .rl4/, or the workspace id above for Supabase.`
            : `**Current folder** (this Cursor workspace): "${currentName}". To use it, call set_workspace with workspace_id "current".`;
        text = `Workspaces:\n${workspaces.map((w, i) => { var _a; return `${i + 1}. ${w.workspace_name} (id: ${w.workspace_id}, snapshots: ${(_a = w.snapshot_count) !== null && _a !== void 0 ? _a : 0})`; }).join("\n")}\n\n${currentLine}`;
    }
    else if (!hasSupabase) {
        text = `Supabase not configured for MCP (missing SUPABASE_URL or RL4_ACCESS_TOKEN in env). Run **RL4: Connect** in the palette so the extension writes .cursor/mcp.json with env, then **Reload Window**. Use **current** workspace: "${currentName}".`;
    }
    else if (authError) {
        text = `Supabase returned 401 (token expired or invalid). Run **RL4: Connect** in the palette, then **Reload Window** so the MCP gets a fresh token.

**Fallback:** For the current folder context, you can read .rl4/evidence.md and .rl4/timeline.md directly via the Read tool. Offer: "En attendant, je peux charger evidence.md et timeline.md du dossier actuel — voulez-vous que je le fasse ?"`;
    }
    else {
        text = `No workspaces in Supabase yet (Supabase is configured; table may be empty or RLS). Use **current** workspace: "${currentName}". After a snapshot from the extension, workspaces should appear.`;
    }
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("set_workspace", "Set the active workspace for get_evidence, get_timeline, get_decisions, search_context. Use workspace_id 'current' to use this Cursor workspace's .rl4/ data; use a workspace id from list_workspaces to read from Supabase.", { workspace_id: z.string().describe("Workspace id from list_workspaces, or 'current' for this folder") }, async (args) => {
    var _a, _b;
    const rawId = String((_a = args.workspace_id) !== null && _a !== void 0 ? _a : "current").trim();
    // Sanitize: only allow uuid-like or "current"
    const id = /^[a-zA-Z0-9_-]+$/.test(rawId) ? rawId : "current";
    selectedWorkspaceId = id;
    if ((workspaceContextCache === null || workspaceContextCache === void 0 ? void 0 : workspaceContextCache.workspaceId) !== id)
        workspaceContextCache = null;
    const isRemote = id !== "current";
    const name = isRemote ? `Supabase workspace ${id}` : (root ? (_b = root.split(/[/\\]/).filter(Boolean).pop()) !== null && _b !== void 0 ? _b : "current" : "current");
    return {
        content: [
            {
                type: "text",
                text: isRemote
                    ? `Workspace set to **${id}** (Supabase). RL4 context is ready: use get_evidence, get_timeline, get_decisions, or search_context(query).`
                    : `Workspace set to **current** (${name}). RL4 context is ready: use get_evidence, get_timeline, get_decisions, or search_context(query).`,
            },
        ],
    };
});
// --- Supabase search (rl4_chunks) when workspace !== "current" ---
async function searchContextFromSupabase(workspaceId, query, limit) {
    const cfg = getSupabaseConfig();
    if (!cfg)
        return "[Supabase not configured. Set SUPABASE_URL and RL4_ACCESS_TOKEN, or run RL4: Connect from any workspace.]";
    try {
        const pattern = `*${query.replace(/[*%]/g, "")}*`;
        const controller = new AbortController();
        // nosemgrep: eval-or-dynamic-code — callback ref, not string eval
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rl4_chunks?workspace_id=eq.${encodeURIComponent(workspaceId)}&content=ilike.${encodeURIComponent(pattern)}&select=content,metadata,source,created_at&order=created_at.desc&limit=${Math.min(limit, 20)}`, {
            headers: {
                apikey: cfg.supabaseAnon,
                Authorization: `Bearer ${cfg.accessToken}`,
                "Content-Type": "application/json",
            },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const base = `[Supabase error ${res.status}. No chunks for workspace ${workspaceId}.]`;
            if (res.status === 401)
                return `${base} Token expired. Run RL4: Connect + Reload Window. Fallback: use search_context with workspace "current" (local .rl4/).`;
            return base;
        }
        const rows = (await res.json());
        if (rows.length === 0)
            return `No matching chunks for query "${query}" in this workspace. Sync chunks from extension or use get_evidence/get_timeline/get_decisions.`;
        const excerpts = rows.map((r) => `[${r.source}${r.created_at ? ` | ${r.created_at}` : ""}]\n${(r.content || "").slice(0, 800)}${(r.content || "").length > 800 ? "…" : ""}`);
        return excerpts.join("\n\n---\n\n");
    }
    catch (e) {
        return `[Failed to search Supabase: ${e instanceof Error ? e.message : String(e)}]`;
    }
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
mcpServer.tool("search_chats", "Search only Cursor chat history (RL4 .rl4/evidence/chat_history.jsonl). Same RAG as search_context with source=chat. Use when user asks to search in their chats or conversation history. Returns chunks with citation [thread_id date] first.", { query: z.string().describe("Search query"), limit: z.number().min(1).max(20).optional().default(10) }, async (args) => {
    const parsed = z.object({ query: z.string(), limit: z.number().min(1).max(20).optional().default(10) }).safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit } = parsed.data;
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit);
        return { content: [{ type: "text", text }] };
    }
    const chunks = searchContext(root, query, { source: "chat", limit });
    const text = chunks.length === 0
        ? `No matching chat messages for "${query}". Chat history is in .rl4/evidence/chat_history.jsonl (filled by extension on startup).`
        : chunks.map((c) => c.excerpt).join("\n\n---\n\n");
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("search_cli", "Search CLI command history (RL4 .rl4/evidence/cli_history.jsonl). Captures shell commands (git, npm, cargo, docker, make...) with exit codes, duration, and output previews. Use when user asks about commands they ran, build results, or terminal activity.", { query: z.string().describe("Search query"), limit: z.number().min(1).max(20).optional().default(10) }, async (args) => {
    const parsed = z.object({ query: z.string(), limit: z.number().min(1).max(20).optional().default(10) }).safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit } = parsed.data;
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit);
        return { content: [{ type: "text", text }] };
    }
    const chunks = searchContext(root, query, { source: "cli", limit });
    const text = chunks.length === 0
        ? `No matching CLI commands for "${query}". CLI history is in .rl4/evidence/cli_history.jsonl (filled by shell hooks or rl4 wrap).`
        : chunks.map((c) => c.excerpt).join("\n\n---\n\n");
    return { content: [{ type: "text", text }] };
});
mcpServer.tool("search_context", "Search RL4 context: evidence, timeline, decisions, chat, cli. When workspace is 'current': local RAG (BM25, RRF, rerank). When workspace is from Supabase: search rl4_chunks. Returns chunks with citation source first (file, line, date). Use source=cli to search CLI command history.", SearchFiltersSchema.shape, async (args) => {
    const parsed = SearchFiltersSchema.safeParse(args);
    if (!parsed.success) {
        return {
            content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
            isError: true,
        };
    }
    const { query, source, tag, date_from, date_to, limit } = parsed.data;
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        const text = await searchContextFromSupabase(selectedWorkspaceId, query, limit !== null && limit !== void 0 ? limit : 10);
        return { content: [{ type: "text", text }] };
    }
    const filters = { source, tag, date_from, date_to, limit };
    const chunks = searchContext(root, query, filters);
    const text = chunks.length === 0
        ? `No matching chunks for query "${query}".`
        : chunks.map((c) => c.excerpt).join("\n\n---\n\n");
    return {
        content: [{ type: "text", text }],
    };
});
// ── rl4_ask: Perplexity-style answer engine ──────────────────────────────────
const AskSchema = z.object({
    query: z.string().describe("Natural language question about your development history"),
    source: z.enum(["evidence", "timeline", "decisions", "chat", "cli"]).optional().describe("Filter by source type"),
    tag: z.string().optional().describe("Filter by tag (e.g. FIX, UI, ARCH)"),
    date_from: z.string().optional().describe("Filter from date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Filter to date (YYYY-MM-DD)"),
    limit: z.number().min(1).max(20).optional().default(5).describe("Max sources to cite (default 5)"),
});
mcpServer.tool("rl4_ask", "Ask a natural language question about your development history and get a cited answer with sources — like Perplexity but for your codebase. Understands intent (why/how/what/when/who), extracts entities (files, dates, tags), expands synonyms, boosts recent results, and suggests related follow-up questions. Use this instead of search_context when you want a structured, cited answer.", AskSchema.shape, async (args) => {
    const parsed = AskSchema.safeParse(args);
    if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    if (isRemoteWorkspace() && selectedWorkspaceId) {
        return { content: [{ type: "text", text: "rl4_ask currently works only for workspace 'current' (local .rl4/). Use search_context for remote Supabase workspaces." }] };
    }
    const { query, source, tag, date_from, date_to, limit } = parsed.data;
    const options = { source, tag, date_from, date_to, limit };
    const result = ask(root, query, options);
    // Format the full Perplexity-style response
    const sections = [];
    // Intent header
    sections.push(`**Intent:** ${result.analysis.intent} (${(result.analysis.intentConfidence * 100).toFixed(0)}% confidence)`);
    if (result.analysis.entities.files.length > 0) {
        sections.push(`**Files detected:** ${result.analysis.entities.files.join(", ")}`);
    }
    if (result.analysis.entities.tags.length > 0) {
        sections.push(`**Tags detected:** ${result.analysis.entities.tags.join(", ")}`);
    }
    if (result.analysis.entities.dates.length > 0) {
        sections.push(`**Dates detected:** ${result.analysis.entities.dates.join(", ")}`);
    }
    const expansionCount = result.analysis.expandedTerms.length;
    if (expansionCount > 3) {
        sections.push(`**Search expanded to:** ${result.analysis.expandedTerms.slice(0, 8).join(", ")}${expansionCount > 8 ? "…" : ""}`);
    }
    sections.push("");
    sections.push(result.answer);
    if (result.relatedQuestions.length > 0) {
        sections.push("\n---\n\n**Related questions:**");
        result.relatedQuestions.forEach((q, i) => sections.push(`${i + 1}. ${q}`));
    }
    sections.push(`\n---\n*${result.stats.returnedChunks} sources from ${result.stats.filteredChunks} chunks (${result.stats.totalChunks} total) in ${result.stats.searchTimeMs}ms*`);
    return { content: [{ type: "text", text: sections.join("\n") }] };
});
mcpServer.tool("run_snapshot", "Run an RL4 headless snapshot (CURSOR/VSIX ONLY — do NOT use from CLI-based LLMs like Codex, Claude Code, or Gemini CLI as it will timeout). Requires the Cursor VSIX extension to be running. For CLI contexts, use get_evidence + get_timeline + search_context instead. Only works when workspace is 'current'.", {}, async () => {
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
    try {
        if (!fs.existsSync(rl4Dir))
            fs.mkdirSync(rl4Dir, { recursive: true });
        // Remove stale result so we know when the new one is written
        if (fs.existsSync(resultPath))
            fs.unlinkSync(resultPath);
        fs.writeFileSync(triggerPath, String(Date.now()), "utf8");
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Failed to write trigger: ${msg}` }], isError: true };
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        // nosemgrep: eval-or-dynamic-code — callback ref, not string eval
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!fs.existsSync(resultPath))
            continue;
        try {
            const raw = fs.readFileSync(resultPath, "utf8");
            const data = JSON.parse(raw);
            if (data.ok && typeof data.prompt === "string") {
                return { content: [{ type: "text", text: data.prompt }] };
            }
            if (data.ok === false && typeof data.error === "string") {
                return { content: [{ type: "text", text: `Snapshot failed: ${data.error}` }], isError: true };
            }
        }
        catch {
            // partial write, retry
        }
    }
    return {
        content: [
            {
                type: "text",
                text: "Snapshot did not complete in 90s. Check: (1) RL4 extension is installed and Cursor window was reloaded, (2) workspace has a .rl4/ folder, (3) Run 'RL4: Snapshot (headless)' from the palette once to confirm extension is active.",
            },
        ],
        isError: true,
    };
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
        const text = removed.length > 0
            ? `RL4: Finalized. Removed: ${removed.join(", ")}.`
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
    try {
        if (!fs.existsSync(blobPath)) {
            return { content: [{ type: "text", text: `[No blob found for checksum ${checksum}.]` }] };
        }
        const content = fs.readFileSync(blobPath, "utf8");
        return { content: [{ type: "text", text: content }] };
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
});
mcpServer.tool("rl4_guardrail", "Validate a query or response against RL4 guardrails. For type=query: non-empty, max 2000 chars. For type=response: max 100000 chars and must contain at least one citation (e.g. .rl4/, L42, or | date). Returns { allowed: boolean, reason?: string }. Use before/after rl4_ask to enforce proof-backed answers.", GuardrailSchema.shape, async (args) => {
    const parsed = GuardrailSchema.safeParse(args);
    if (!parsed.success) {
        return {
            content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: `Invalid arguments: ${parsed.error.message}` }) }],
            isError: true,
        };
    }
    const { text, type } = parsed.data;
    const trimmed = text.trim();
    if (type === "query") {
        if (trimmed.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Query must not be empty." }) }] };
        }
        if (trimmed.length > GUARDRAIL_QUERY_MAX_LEN) {
            return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: `Query exceeds ${GUARDRAIL_QUERY_MAX_LEN} characters.` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ allowed: true }) }] };
    }
    if (type === "response") {
        if (trimmed.length > GUARDRAIL_RESPONSE_MAX_LEN) {
            return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: `Response exceeds ${GUARDRAIL_RESPONSE_MAX_LEN} characters.` }) }] };
        }
        if (!CITATION_PATTERN.test(trimmed)) {
            return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Response must contain at least one citation (e.g. .rl4/ path, L42, or | date)." }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ allowed: true }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Invalid type." }) }], isError: true };
});
async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    // Log to stderr so we don't break stdio
    console.error("[RL4 MCP] Server running. Workspace root:", root);
}
main().catch((err) => {
    console.error("[RL4 MCP] Fatal:", err);
    process.exit(1);
});
