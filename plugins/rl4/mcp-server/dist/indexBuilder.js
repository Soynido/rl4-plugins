/**
 * Build metadata index from .rl4/: evidence.md, timeline.md, decisions.jsonl, chat (optional).
 * Emits IndexedChunk[] for pre-filter and hybrid search.
 * Fix #3: persistent index cache in .rl4/.cache/ keyed by source file mtimes.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { chunkEvidence, chunkTimeline, chunkDecisions, chunkChat, chunkCli, chunkCodeFile, } from "./chunking.js";
import { getEvidencePath, getTimelinePath, getDecisionsPath, readFileSafe, readDecisions, } from "./workspace.js";
import { resolveUnderRoot } from "./safePath.js";
import { scanWorkspace } from "./workspaceScanner.js";
const EVIDENCE_DIR = ".rl4/evidence";
const CHAT_HISTORY = "chat_history.jsonl";
const CLI_HISTORY = "cli_history.jsonl";
const CACHE_DIR = ".rl4/.cache";
const CACHE_FILENAME = "metadata_index.json";
function mtimeSafe(p) {
    try {
        if (!fs.existsSync(p))
            return 0;
        return fs.statSync(p).mtimeMs;
    }
    catch {
        return 0;
    }
}
const SNAPSHOTS_DIR = ".rl4/snapshots";
const FILE_INDEX = "file_index.json";
/** Stable ID for temporal history chunks (deterministic, no content dependency) */
function stableIdForHistory(filePath, versionCount) {
    return crypto.createHash("sha256").update(`file-history:${filePath}:${versionCount}`, "utf8").digest("hex").slice(0, 24);
}
/** Return today's date in the user's local timezone (YYYY-MM-DD), not UTC.
 *  Avoids the 23h–00h UTC mismatch for European timezones. */
function localDateStr(d) {
    const dt = d || new Date();
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
/** Format a timestamp in local time for display (HH:MM) */
function localTimeStr(isoTs) {
    try {
        const d = new Date(isoTs);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    catch {
        return isoTs.slice(11, 16);
    }
}
/** Signature for cache invalidation: root + mtimes of all source files.
 * Includes workspace package.json mtime as proxy for "code changed" when no snapshots exist. */
function cacheSignature(root) {
    const evidencePath = getEvidencePath(root);
    const timelinePath = getTimelinePath(root);
    const decisionsPath = getDecisionsPath(root);
    const chatPath = resolveUnderRoot(root, ".rl4", "evidence", CHAT_HISTORY);
    const cliPath = resolveUnderRoot(root, ".rl4", "evidence", CLI_HISTORY);
    const sessionsPath = resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl");
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const fileIndexPath = resolveUnderRoot(root, ".rl4", "snapshots", FILE_INDEX);
    // Include package.json mtime as a proxy for workspace changes (cheap invalidation for live scan)
    const packageJsonPath = path.join(root, "package.json");
    const archiveDirPath = resolveUnderRoot(root, ".rl4", ".internal", "archives");
    const parts = [
        root,
        mtimeSafe(evidencePath),
        mtimeSafe(timelinePath),
        mtimeSafe(decisionsPath),
        mtimeSafe(chatPath),
        mtimeSafe(cliPath),
        mtimeSafe(sessionsPath),
        mtimeSafe(activityPath),
        mtimeSafe(fileIndexPath),
        mtimeSafe(packageJsonPath),
        mtimeSafe(archiveDirPath), // invalidate when new archives are created by housekeeper
    ];
    return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
}
function loadCachedIndex(root) {
    const cacheDir = resolveUnderRoot(root, ".rl4", ".cache");
    const cachePath = resolveUnderRoot(root, ".rl4", ".cache", CACHE_FILENAME);
    try {
        if (!fs.existsSync(cachePath))
            return null;
        const raw = fs.readFileSync(cachePath, "utf-8");
        const payload = JSON.parse(raw);
        if (payload.signature !== cacheSignature(root))
            return null;
        if (payload.root !== root)
            return null;
        return {
            chunks: payload.chunks,
            builtAt: payload.builtAt,
            root: payload.root,
        };
    }
    catch {
        return null;
    }
}
function writeCachedIndex(root, index) {
    const cacheDir = resolveUnderRoot(root, ".rl4", ".cache");
    const cachePath = resolveUnderRoot(root, ".rl4", ".cache", CACHE_FILENAME);
    try {
        if (!fs.existsSync(cacheDir))
            fs.mkdirSync(cacheDir, { recursive: true });
        const payload = {
            signature: cacheSignature(root),
            builtAt: index.builtAt,
            root: index.root,
            chunks: index.chunks,
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload), "utf-8");
    }
    catch {
        // best-effort; index still returned
    }
}
/** In-memory cache: avoids re-reading + parsing JSON disk cache on every MCP call */
let memIndexCache = null;
/** Expose signature for engine cache invalidation in rag.ts */
export function getIndexSignature(root) {
    return cacheSignature(root);
}
export function buildMetadataIndex(root) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    var _o;
    // Level 1: in-memory cache (instant — no disk I/O, no JSON parse)
    const sig = cacheSignature(root);
    if (memIndexCache && memIndexCache.signature === sig) {
        return memIndexCache.index;
    }
    // Level 2: disk cache
    const cached = loadCachedIndex(root);
    if (cached) {
        memIndexCache = { signature: sig, index: cached };
        return cached;
    }
    const chunks = [];
    const evidencePath = getEvidencePath(root);
    const timelinePath = getTimelinePath(root);
    const decisionsPath = getDecisionsPath(root);
    const evidenceDir = resolveUnderRoot(root, ".rl4", "evidence");
    // evidence.md
    const evidenceContent = readFileSafe(evidencePath);
    if (evidenceContent) {
        const evidenceChunks = chunkEvidence(evidenceContent, ".rl4/evidence.md");
        chunks.push(...evidenceChunks);
    }
    // timeline.md
    const timelineContent = readFileSafe(timelinePath);
    if (timelineContent) {
        const timelineChunks = chunkTimeline(timelineContent, ".rl4/timeline.md");
        chunks.push(...timelineChunks);
    }
    // decisions.jsonl
    const decisions = readDecisions(root);
    if (decisions.length > 0) {
        const decisionsAsRecords = decisions.map((d) => ({
            id: d.id,
            intent_text: d.intent_text,
            chosen_option: d.chosen_option,
            confidence_gate: d.confidence_gate,
            isoTimestamp: d.isoTimestamp,
        }));
        const decisionsChunks = chunkDecisions(decisionsAsRecords, path.basename(decisionsPath));
        chunks.push(...decisionsChunks);
    }
    // chat_history.jsonl (optional) — includes archived .gz files for full memory
    const chatPath = resolveUnderRoot(root, ".rl4", "evidence", CHAT_HISTORY);
    {
        const messages = [];
        // Helper: parse JSONL lines into messages array
        const parseJsonlLines = (raw) => {
            var _a;
            const lines = raw.trim().split("\n").filter(Boolean);
            for (const line of lines) {
                try {
                    const m = JSON.parse(line);
                    // Extension writes "content"; legacy/spec may use "text"
                    const text = ((_a = m.text) !== null && _a !== void 0 ? _a : m.content);
                    messages.push({
                        thread_id: m.thread_id,
                        timestamp: m.timestamp,
                        role: m.role,
                        text: text !== null && text !== void 0 ? text : "",
                    });
                }
                catch {
                    // skip malformed
                }
            }
        };
        // 1. Read archived chat_history .gz files (oldest first → chronological order)
        const archiveDir = resolveUnderRoot(root, ".rl4", ".internal", "archives");
        if (fs.existsSync(archiveDir)) {
            try {
                const archiveFiles = fs.readdirSync(archiveDir)
                    .filter(f => f.startsWith("chat_history.jsonl.") && f.endsWith(".archive.gz"))
                    .sort(); // chronological by timestamp in filename
                for (const af of archiveFiles) {
                    try {
                        const compressed = fs.readFileSync(path.join(archiveDir, af));
                        const raw = zlib.gunzipSync(compressed).toString("utf-8");
                        parseJsonlLines(raw);
                    }
                    catch {
                        // skip corrupt archive
                    }
                }
            }
            catch {
                // archive dir read failed — non-fatal
            }
        }
        // 2. Read current chat_history.jsonl (newest data)
        if (fs.existsSync(chatPath)) {
            const raw = readFileSafe(chatPath);
            if (raw)
                parseJsonlLines(raw);
        }
        if (messages.length > 0) {
            const chatChunks = chunkChat(messages, ".rl4/evidence/chat_history.jsonl");
            chunks.push(...chatChunks);
        }
    }
    // sessions.jsonl — inject live session data (last 24h) so RAG sees today's activity
    const sessionsPath = resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl");
    if (fs.existsSync(sessionsPath)) {
        const raw = readFileSafe(sessionsPath);
        if (raw) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const lines = raw.trim().split("\n").filter(Boolean);
            const recentSessions = [];
            for (let i = lines.length - 1; i >= 0 && recentSessions.length < 50; i--) {
                try {
                    const s = JSON.parse(lines[i]);
                    const t = s.t ? new Date(String(s.t)).getTime() : 0;
                    if (t < cutoff)
                        break; // sessions are chronological, stop when past 24h
                    const files = Array.isArray(s.files) ? s.files.join(", ") : "";
                    const pattern = ((_a = s.pattern) === null || _a === void 0 ? void 0 : _a.type) || "unknown";
                    const events = s.events_count || 0;
                    const localTime = localTimeStr(String(s.t || ""));
                    recentSessions.unshift(`Session ${String(s.burst_id || "").slice(-6)} at ${localTime} — ${events} events on [${files}] (${pattern})`);
                }
                catch { /* skip */ }
            }
            if (recentSessions.length > 0) {
                const sessionSummary = `LIVE ACTIVITY (last 24h): ${recentSessions.length} work sessions detected today.\n\n` +
                    recentSessions.slice(-20).join("\n");
                const today = localDateStr();
                chunks.push({
                    id: "live-sessions-today",
                    content: sessionSummary,
                    metadata: { source: "evidence", file: ".rl4/evidence/sessions.jsonl", tag: "SESSION", date: today, section: "LIVE SESSIONS" },
                    citation: { file: ".rl4/evidence/sessions.jsonl", line_or_range: "live", date: today, source: "evidence" },
                });
            }
        }
    }
    // activity.jsonl — inject recent file activity (last 24h)
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    if (fs.existsSync(activityPath)) {
        const raw = readFileSafe(activityPath);
        if (raw) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const lines = raw.trim().split("\n").filter(Boolean);
            const fileCounts = {};
            let totalEvents = 0;
            for (let i = lines.length - 1; i >= 0 && totalEvents < 500; i--) {
                try {
                    const e = JSON.parse(lines[i]);
                    const t = e.t ? new Date(String(e.t)).getTime() : 0;
                    if (t < cutoff)
                        break;
                    const f = String(e.file || e.path || "");
                    if (f) {
                        fileCounts[f] = (fileCounts[f] || 0) + 1;
                        totalEvents++;
                    }
                }
                catch { /* skip */ }
            }
            if (totalEvents > 0) {
                const sorted = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
                const activitySummary = `LIVE FILE ACTIVITY (last 24h): ${totalEvents} file events across ${Object.keys(fileCounts).length} files.\n\n` +
                    `Most active files today:\n` +
                    sorted.map(([f, c]) => `  ${f} — ${c} edits`).join("\n");
                const todayAct = localDateStr();
                chunks.push({
                    id: "live-activity-today",
                    content: activitySummary,
                    metadata: { source: "evidence", file: ".rl4/evidence/activity.jsonl", tag: "ACTIVITY", date: todayAct, section: "LIVE ACTIVITY" },
                    citation: { file: ".rl4/evidence/activity.jsonl", line_or_range: "live", date: todayAct, source: "evidence" },
                });
            }
        }
    }
    // intent_chains.jsonl — file change events (delta, SHA, intent signals)
    // Includes archived .gz files for full history
    {
        const intentEvents = [];
        const parseIntentLines = (raw) => {
            var _a, _b, _c, _d;
            for (const line of raw.trim().split("\n").filter(Boolean)) {
                try {
                    const e = JSON.parse(line);
                    if (!e.t || !e.file)
                        continue;
                    const delta = e.delta;
                    intentEvents.push({
                        t: String(e.t),
                        file: String(e.file),
                        delta: { linesAdded: (_a = delta === null || delta === void 0 ? void 0 : delta.linesAdded) !== null && _a !== void 0 ? _a : 0, linesRemoved: (_b = delta === null || delta === void 0 ? void 0 : delta.linesRemoved) !== null && _b !== void 0 ? _b : 0, netChange: (_c = delta === null || delta === void 0 ? void 0 : delta.netChange) !== null && _c !== void 0 ? _c : 0 },
                        intent_signal: String((_d = e.intent_signal) !== null && _d !== void 0 ? _d : "unknown"),
                        burst_id: e.burst_id ? String(e.burst_id) : undefined,
                    });
                }
                catch { /* skip */ }
            }
        };
        // 1. Read archived intent_chains .gz files (oldest first)
        const intentArchiveDir = resolveUnderRoot(root, ".rl4", ".internal", "archives");
        if (fs.existsSync(intentArchiveDir)) {
            try {
                const archiveFiles = fs.readdirSync(intentArchiveDir)
                    .filter(f => f.startsWith("intent_chains.jsonl.") && f.endsWith(".archive.gz"))
                    .sort();
                for (const af of archiveFiles) {
                    try {
                        const compressed = fs.readFileSync(path.join(intentArchiveDir, af));
                        const raw = zlib.gunzipSync(compressed).toString("utf-8");
                        parseIntentLines(raw);
                    }
                    catch { /* skip corrupt archive */ }
                }
            }
            catch { /* archive dir read failed */ }
        }
        // 2. Read current intent_chains.jsonl
        const intentChainsPath = resolveUnderRoot(root, ".rl4", "evidence", "intent_chains.jsonl");
        if (fs.existsSync(intentChainsPath)) {
            const raw = readFileSafe(intentChainsPath);
            if (raw)
                parseIntentLines(raw);
        }
        // 3. Chunk by file — group events per file, create trajectory summaries
        if (intentEvents.length > 0) {
            const byFile = {};
            for (const e of intentEvents) {
                ((_b = byFile[_o = e.file]) !== null && _b !== void 0 ? _b : (byFile[_o] = [])).push(e);
            }
            const fileEntries = Object.entries(byFile)
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, 50); // top 50 most-changed files
            for (const [filePath, events] of fileEntries) {
                const sorted = events.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
                const totalAdded = sorted.reduce((s, e) => s + e.delta.linesAdded, 0);
                const totalRemoved = sorted.reduce((s, e) => s + e.delta.linesRemoved, 0);
                const signals = [...new Set(sorted.map(e => e.intent_signal))].join(", ");
                const firstDate = sorted[0].t.slice(0, 10);
                const lastDate = sorted[sorted.length - 1].t.slice(0, 10);
                const content = `FILE CHANGE HISTORY: ${filePath}\n` +
                    `${sorted.length} changes from ${firstDate} to ${lastDate}\n` +
                    `Total: +${totalAdded}/-${totalRemoved} lines | Signals: ${signals}\n\n` +
                    sorted.slice(-20).map(e => {
                        const time = localTimeStr(e.t);
                        return `  ${time} ${e.intent_signal} +${e.delta.linesAdded}/-${e.delta.linesRemoved} (${e.delta.netChange >= 0 ? "+" : ""}${e.delta.netChange})`;
                    }).join("\n");
                chunks.push({
                    id: `intent-chain-${filePath.replace(/[^a-zA-Z0-9]/g, "-")}`,
                    content,
                    metadata: { source: "evidence", file: ".rl4/evidence/intent_chains.jsonl", tag: "FILE_HISTORY", date: lastDate, section: "INTENT CHAINS" },
                    citation: { file: ".rl4/evidence/intent_chains.jsonl", line_or_range: `${filePath}`, date: lastDate, source: "evidence" },
                });
            }
        }
    }
    // cli_history.jsonl (optional — from rl4-cli)
    const cliHistoryPath = resolveUnderRoot(root, ".rl4", "evidence", CLI_HISTORY);
    if (fs.existsSync(cliHistoryPath)) {
        const raw = readFileSafe(cliHistoryPath);
        if (raw) {
            const lines = raw.trim().split("\n").filter(Boolean);
            const events = [];
            for (const line of lines) {
                try {
                    const e = JSON.parse(line);
                    events.push({
                        t: String((_c = e.t) !== null && _c !== void 0 ? _c : ""),
                        command: String((_d = e.command) !== null && _d !== void 0 ? _d : ""),
                        tool: String((_e = e.tool) !== null && _e !== void 0 ? _e : "unknown"),
                        exit_code: Number((_f = e.exit_code) !== null && _f !== void 0 ? _f : 0),
                        duration_ms: Number((_g = e.duration_ms) !== null && _g !== void 0 ? _g : 0),
                        cwd: String((_h = e.cwd) !== null && _h !== void 0 ? _h : ""),
                        stdout_preview: e.stdout_preview,
                        stderr_preview: e.stderr_preview,
                        session_id: e.session_id,
                    });
                }
                catch {
                    // skip malformed
                }
            }
            if (events.length > 0) {
                const cliChunks = chunkCli(events, ".rl4/evidence/cli_history.jsonl", 20);
                chunks.push(...cliChunks);
            }
        }
    }
    // code files from content store (snapshots/*.content) — preferred path (pre-indexed by extension)
    // PERF: skip build artifacts — dist/, .package/, .d.ts, minified single-line JS files pollute search
    const SKIP_CODE_PATTERNS = [
        /\/dist\//, // compiled output
        /\/.package\//, // VSIX package artifacts
        /\/node_modules\//, // should never be here but safety
        /\/\.next\//, // Next.js build
        /\/build\//, // generic build dir
        /\.d\.ts$/, // TypeScript declarations
        /\.min\.js$/, // minified JS
        /\.map$/, // source maps
        /package-lock\.json$/,
        /yarn\.lock$/,
    ];
    const fileIndexPath = resolveUnderRoot(root, ".rl4", "snapshots", FILE_INDEX);
    const checksumIndexPath = resolveUnderRoot(root, ".rl4", "snapshots", "checksum_index.json");
    let codeFilesIndexed = 0;
    let codeFilesExpected = 0;
    const indexedFilePaths = new Set(); // track files indexed from snapshot to avoid duplicates in live scan
    // Load checksum index for temporal metadata (timestamps, linesAdded/linesRemoved)
    let checksumIndex = {};
    if (fs.existsSync(checksumIndexPath)) {
        try {
            const raw = readFileSafe(checksumIndexPath);
            if (raw)
                checksumIndex = JSON.parse(raw);
        }
        catch { /* best-effort */ }
    }
    if (fs.existsSync(fileIndexPath)) {
        try {
            const raw = readFileSafe(fileIndexPath);
            if (raw) {
                const fileIndex = JSON.parse(raw);
                codeFilesExpected = Object.keys(fileIndex).length;
                const snapshotsDir = resolveUnderRoot(root, ".rl4", "snapshots");
                for (const [filePath, checksums] of Object.entries(fileIndex)) {
                    if (!Array.isArray(checksums) || checksums.length === 0)
                        continue;
                    // Skip build artifacts
                    if (SKIP_CODE_PATTERNS.some(p => p.test(filePath)))
                        continue;
                    const latestChecksum = checksums[checksums.length - 1];
                    const blobPath = path.join(snapshotsDir, `${latestChecksum}.content`);
                    const blobPathGz = path.join(snapshotsDir, `${latestChecksum}.content.gz`);
                    let content = null;
                    if (fs.existsSync(blobPath)) {
                        content = readFileSafe(blobPath);
                    }
                    else if (fs.existsSync(blobPathGz)) {
                        // Claude Code hook saves blobs as .content.gz — decompress on the fly
                        try {
                            const compressed = fs.readFileSync(blobPathGz);
                            content = zlib.gunzipSync(compressed).toString("utf-8");
                        }
                        catch { /* best-effort */ }
                    }
                    if (content) {
                        const codeChunks = chunkCodeFile(filePath, content);
                        // Enrich code chunks with temporal metadata from checksum_index
                        const meta = checksumIndex[latestChecksum];
                        if (meta === null || meta === void 0 ? void 0 : meta.isoTimestamp) {
                            const dateStr = meta.isoTimestamp.slice(0, 10); // YYYY-MM-DD
                            for (const chunk of codeChunks) {
                                chunk.metadata.date = dateStr;
                                chunk.citation.date = dateStr;
                            }
                        }
                        chunks.push(...codeChunks);
                        codeFilesIndexed++;
                        indexedFilePaths.add(filePath);
                    }
                    // ── Temporal history chunk: version timeline for multi-version files ──
                    if (checksums.length >= 2) {
                        const historyLines = [];
                        historyLines.push(`FILE VERSION HISTORY: ${filePath} (${checksums.length} versions)\n`);
                        for (let vi = 0; vi < checksums.length; vi++) {
                            const cm = checksumIndex[checksums[vi]];
                            if (!cm)
                                continue;
                            const d = new Date(cm.timestamp);
                            const dateLocal = localDateStr(d);
                            const timeLocal = localTimeStr(cm.isoTimestamp);
                            const diffStr = vi === 0
                                ? `created (${cm.lines} lines)`
                                : `+${(_j = cm.linesAdded) !== null && _j !== void 0 ? _j : "?"}/-${(_k = cm.linesRemoved) !== null && _k !== void 0 ? _k : "?"} lines (${cm.lines} total)`;
                            historyLines.push(`  v${vi + 1} ${dateLocal} ${timeLocal} — ${diffStr} [${cm.size} bytes]`);
                        }
                        const latestMeta = checksumIndex[latestChecksum];
                        const latestDate = (_m = (_l = latestMeta === null || latestMeta === void 0 ? void 0 : latestMeta.isoTimestamp) === null || _l === void 0 ? void 0 : _l.slice(0, 10)) !== null && _m !== void 0 ? _m : localDateStr();
                        const historyContent = historyLines.join("\n");
                        chunks.push({
                            id: stableIdForHistory(filePath, checksums.length),
                            content: historyContent,
                            metadata: { source: "evidence", file: filePath, tag: "FILE_HISTORY", date: latestDate, section: "FILE VERSION HISTORY" },
                            citation: { file: filePath, line_or_range: `${checksums.length} versions`, date: latestDate, source: "evidence" },
                        });
                    }
                }
            }
        }
        catch {
            // best-effort: code indexing failure doesn't break other sources
        }
    }
    // FALLBACK: Live workspace scan when snapshots are missing or incomplete.
    // Triggers when: no file_index.json, OR less than 50% of expected files have blobs.
    // This makes RL4 work as "Perplexity for codebase" even with partial or missing snapshots.
    const snapshotCoverage = codeFilesExpected > 0 ? codeFilesIndexed / codeFilesExpected : 0;
    if ((codeFilesIndexed === 0 || snapshotCoverage < 0.5) && root) {
        try {
            const scan = scanWorkspace(root);
            if (scan.files.length > 0) {
                let liveIndexed = 0;
                for (const file of scan.files) {
                    if (indexedFilePaths.has(file.relativePath))
                        continue; // already indexed from snapshot blob
                    const content = readFileSafe(file.absolutePath);
                    if (content) {
                        const codeChunks = chunkCodeFile(file.relativePath, content);
                        chunks.push(...codeChunks);
                        liveIndexed++;
                    }
                }
                console.error(`[RL4 MCP] Live scan: indexed ${liveIndexed} files (${scan.scanTimeMs}ms, ${scan.skippedDirs} dirs skipped${scan.truncated ? ", TRUNCATED" : ""}${codeFilesIndexed > 0 ? `, ${codeFilesIndexed} from snapshot` : ""})`);
            }
        }
        catch {
            // best-effort: live scan failure doesn't break other sources
        }
    }
    const index = {
        chunks,
        builtAt: new Date().toISOString(),
        root,
    };
    memIndexCache = { signature: sig, index };
    writeCachedIndex(root, index);
    return index;
}
/** Pre-filter chunks by metadata (date, tag, source, file) */
export function filterChunks(chunks, filters) {
    return chunks.filter((c) => {
        var _a, _b, _c;
        if (filters.source && c.metadata.source !== filters.source)
            return false;
        if (filters.tag && c.metadata.tag !== filters.tag)
            return false;
        // File filter: substring match on chunk's file path
        if (filters.file) {
            const chunkFile = ((_b = (_a = c.metadata.file) !== null && _a !== void 0 ? _a : c.citation.file) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (!chunkFile.includes(filters.file.toLowerCase()))
                return false;
        }
        const date = (_c = c.metadata.date) !== null && _c !== void 0 ? _c : c.citation.date;
        if (!date)
            return true;
        if (filters.date_from && date < filters.date_from)
            return false;
        if (filters.date_to && date > filters.date_to)
            return false;
        return true;
    });
}
