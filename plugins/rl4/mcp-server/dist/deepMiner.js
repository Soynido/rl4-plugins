/**
 * deepMiner.ts — Forensic SQLite recovery from ALL Cursor workspaces.
 *
 * Scans ~/Library/Application Support/Cursor/User/workspaceStorage/*
 * to find orphan chat history from other workspaces, including messages
 * from before RL4 was installed.
 *
 * Uses a 3-level ContextMatcher with Unique Intent Identifiers to filter
 * only messages relevant to the current project.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { scanItemToChatMessage } from "./scanItemTransformer.js";
// ── ContextMatcher — 3-level Unique Intent Identifiers ──
const LEVEL_1_IDENTIFIERS = [
    "RCEP", "MIG", "RL4SnapshotGenerator", "scanItemToChatMessage",
    "intent_graph", "CRE", "causal_engine", "rebuildAll",
];
const LEVEL_2_IDENTIFIERS = [
    "rl4", "snapshot-extension", "evidence.ts", "hot_score",
    "causal", "lockedAppend", "backfill", "guardrail",
];
const LEVEL_3_IDENTIFIERS = [
    "popup.js", "forensic-scraper.js", "cliSnapshot",
    "skills.mdc", "timeline.md", "evidence.md",
];
function computeMatchScore(text) {
    const lower = text.toLowerCase();
    let l1 = 0, l2 = 0, l3 = 0;
    for (const id of LEVEL_1_IDENTIFIERS) {
        if (text.includes(id) || lower.includes(id.toLowerCase()))
            l1++;
    }
    for (const id of LEVEL_2_IDENTIFIERS) {
        if (lower.includes(id.toLowerCase()))
            l2++;
    }
    for (const id of LEVEL_3_IDENTIFIERS) {
        if (lower.includes(id.toLowerCase()))
            l3++;
    }
    // Score: L1 matches count 3x, L2 count 2x, L3 count 1x
    const raw = l1 * 3 + l2 * 2 + l3;
    // Normalize to 0-1 (cap at 10 for max score)
    return Math.min(1, raw / 10);
}
// ── SQLite query helper (reuses sqlite3 CLI pattern from cliSnapshot.ts) ──
function sqliteQuery(dbPath, sql) {
    return new Promise((resolve) => {
        execFile("sqlite3", [dbPath, sql], {
            maxBuffer: 50 * 1024 * 1024,
            timeout: 15000,
        }, (error, stdout) => {
            if (error) {
                resolve("");
            }
            else {
                resolve(String(stdout || ""));
            }
        });
    });
}
function sqliteQueryJson(dbPath, sql) {
    return new Promise((resolve) => {
        execFile("sqlite3", ["-json", dbPath, sql], {
            maxBuffer: 50 * 1024 * 1024,
            timeout: 15000,
        }, (error, stdout) => {
            if (error || !stdout) {
                resolve([]);
            }
            else {
                try {
                    resolve(JSON.parse(String(stdout)));
                }
                catch {
                    resolve([]);
                }
            }
        });
    });
}
// ── Core scanning ──
/**
 * List all workspace storage directories.
 */
function listWorkspaceStorageDirs() {
    const wsStorageBase = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
    if (!fs.existsSync(wsStorageBase))
        return [];
    return fs.readdirSync(wsStorageBase)
        .map(d => path.join(wsStorageBase, d))
        .filter(d => {
        try {
            return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "state.vscdb"));
        }
        catch {
            return false;
        }
    });
}
/**
 * Get the original workspace folder path from workspace.json.
 */
function getWorkspaceFolder(wsDir) {
    try {
        const wsJson = path.join(wsDir, "workspace.json");
        if (fs.existsSync(wsJson)) {
            const data = JSON.parse(fs.readFileSync(wsJson, "utf8"));
            return data.folder || data.workspace || path.basename(wsDir);
        }
    }
    catch { /* ignore */ }
    return path.basename(wsDir);
}
/**
 * Extract messages from a single workspace's state.vscdb.
 */
async function extractFromWorkspace(wsDir, keywords) {
    const dbPath = path.join(wsDir, "state.vscdb");
    const messages = [];
    // 1. Extract aiService.generations from ItemTable
    const genRaw = await sqliteQuery(dbPath, `SELECT value FROM ItemTable WHERE key = 'aiService.generations';`);
    let allText = genRaw; // For match scoring
    if (genRaw.trim()) {
        try {
            const items = JSON.parse(genRaw);
            if (Array.isArray(items)) {
                for (const item of items) {
                    if (!item.textDescription && !item.text)
                        continue;
                    const msg = scanItemToChatMessage({
                        generationUUID: item.generationUUID || item.id,
                        unixMs: item.unixMs || item.unix_ms || Date.now(),
                        type: item.type || "assistant",
                        textDescription: item.textDescription || item.text || "",
                        provider: "cursor_orphan",
                        transcript_ref: item.transcript_ref || item.thread_id || `orphan-${path.basename(wsDir)}`,
                    });
                    if (msg.content.length > 0) {
                        msg.source = "recovered_sqlite";
                        messages.push(msg);
                    }
                }
            }
        }
        catch { /* parse error — skip */ }
    }
    // 2. Extract composer data from cursorDiskKV
    const composerRows = await sqliteQueryJson(dbPath, `SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 50;`);
    for (const row of composerRows) {
        try {
            const data = JSON.parse(row.value);
            allText += " " + JSON.stringify(data).slice(0, 10000);
            // Extract bubbles if present
            if (data.allBubbles && Array.isArray(data.allBubbles)) {
                for (const bubble of data.allBubbles) {
                    const text = bubble.text || bubble.rawText || "";
                    if (!text || text.length < 10)
                        continue;
                    const unixMs = bubble.createdAt || bubble.timestamp || Date.now();
                    const msg = {
                        id: `composer-${path.basename(wsDir)}-${bubble.bubbleId || unixMs}`,
                        thread_id: `composer-${data.composerId || path.basename(wsDir)}`,
                        role: bubble.type === 1 || bubble.role === "user" ? "user" : "assistant",
                        content: text,
                        timestamp: new Date(unixMs).toISOString(),
                        unix_ms: typeof unixMs === "number" ? unixMs : Date.now(),
                        provider: "cursor_orphan",
                    };
                    msg.source = "recovered_sqlite";
                    messages.push(msg);
                }
            }
        }
        catch { /* skip */ }
    }
    // 3. Compute match score
    const combinedText = allText + " " + messages.map(m => m.content).join(" ").slice(0, 50000);
    const keywordScore = keywords.some(k => combinedText.toLowerCase().includes(k.toLowerCase())) ? 0.2 : 0;
    const intentScore = computeMatchScore(combinedText);
    const matchScore = Math.min(1, keywordScore + intentScore);
    // 4. Date range
    let minMs = Infinity, maxMs = -Infinity;
    for (const m of messages) {
        if (m.unix_ms < minMs)
            minMs = m.unix_ms;
        if (m.unix_ms > maxMs)
            maxMs = m.unix_ms;
    }
    return {
        messages,
        matchScore,
        dateRange: {
            from: minMs === Infinity ? "" : new Date(minMs).toISOString(),
            to: maxMs === -Infinity ? "" : new Date(maxMs).toISOString(),
        },
    };
}
/**
 * Scan ALL workspaceStorage for orphan messages relevant to the current project.
 *
 * @param keywords — keywords to boost relevance scoring
 * @param includeAll — if true, include ALL workspaces regardless of match score
 * @returns orphan workspace info + recovered messages
 */
export async function scanOrphanWorkspaces(keywords = ["rl4", "snapshot", "RCEP"], includeAll = false) {
    const wsDirs = listWorkspaceStorageDirs();
    const orphans = [];
    const allMessages = [];
    for (const wsDir of wsDirs) {
        try {
            const result = await extractFromWorkspace(wsDir, keywords);
            if (result.messages.length === 0)
                continue;
            // Filter by match score unless includeAll
            const threshold = includeAll ? 0 : 0.15;
            if (result.matchScore < threshold)
                continue;
            const folder = getWorkspaceFolder(wsDir);
            orphans.push({
                id: path.basename(wsDir),
                folder,
                dbPath: path.join(wsDir, "state.vscdb"),
                messageCount: result.messages.length,
                matchScore: result.matchScore,
                dateRange: result.dateRange,
            });
            allMessages.push(...result.messages);
        }
        catch { /* skip broken workspace */ }
    }
    return { orphans, messages: allMessages, scannedCount: wsDirs.length };
}
/**
 * Scan globalStorage for composer data not tied to any workspace.
 */
export async function scanGlobalStorage(keywords = ["rl4", "snapshot", "RCEP"]) {
    const globalDbPath = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    if (!fs.existsSync(globalDbPath)) {
        return { messages: [], composerCount: 0 };
    }
    const messages = [];
    // Find composer keys that match our keywords
    const composerKeys = await sqliteQueryJson(globalDbPath, `SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 200;`);
    let composerCount = 0;
    for (const row of composerKeys) {
        try {
            const valueRaw = await sqliteQuery(globalDbPath, `SELECT CAST(value AS TEXT) FROM cursorDiskKV WHERE key = '${row.key.replace(/'/g, "''")}';`);
            if (!valueRaw)
                continue;
            const data = JSON.parse(valueRaw);
            const dataText = JSON.stringify(data).slice(0, 20000);
            // Check relevance
            const hasKeyword = keywords.some(k => dataText.toLowerCase().includes(k.toLowerCase()));
            const intentScore = computeMatchScore(dataText);
            if (!hasKeyword && intentScore < 0.15)
                continue;
            composerCount++;
            if (data.allBubbles && Array.isArray(data.allBubbles)) {
                for (const bubble of data.allBubbles) {
                    const text = bubble.text || bubble.rawText || "";
                    if (!text || text.length < 10)
                        continue;
                    const unixMs = bubble.createdAt || bubble.timestamp || Date.now();
                    const msg = {
                        id: `global-composer-${data.composerId || "unknown"}-${bubble.bubbleId || unixMs}`,
                        thread_id: `global-composer-${data.composerId || "unknown"}`,
                        role: bubble.type === 1 || bubble.role === "user" ? "user" : "assistant",
                        content: text,
                        timestamp: new Date(unixMs).toISOString(),
                        unix_ms: typeof unixMs === "number" ? unixMs : Date.now(),
                        provider: "cursor_global",
                    };
                    msg.source = "recovered_sqlite";
                    messages.push(msg);
                }
            }
        }
        catch { /* skip */ }
    }
    return { messages, composerCount };
}
