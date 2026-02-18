/**
 * Build metadata index from .rl4/: evidence.md, timeline.md, decisions.jsonl, chat (optional).
 * Emits IndexedChunk[] for pre-filter and hybrid search.
 * Fix #3: persistent index cache in .rl4/.cache/ keyed by source file mtimes.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { chunkEvidence, chunkTimeline, chunkDecisions, chunkChat, chunkCli, chunkCodeFile, } from "./chunking.js";
import { getEvidencePath, getTimelinePath, getDecisionsPath, readFileSafe, readDecisions, } from "./workspace.js";
import { resolveUnderRoot } from "./safePath.js";
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
/** Signature for cache invalidation: root + mtimes of all source files */
function cacheSignature(root) {
    const evidencePath = getEvidencePath(root);
    const timelinePath = getTimelinePath(root);
    const decisionsPath = getDecisionsPath(root);
    const chatPath = resolveUnderRoot(root, ".rl4", "evidence", CHAT_HISTORY);
    const cliPath = resolveUnderRoot(root, ".rl4", "evidence", CLI_HISTORY);
    const fileIndexPath = resolveUnderRoot(root, ".rl4", "snapshots", FILE_INDEX);
    const parts = [
        root,
        mtimeSafe(evidencePath),
        mtimeSafe(timelinePath),
        mtimeSafe(decisionsPath),
        mtimeSafe(chatPath),
        mtimeSafe(cliPath),
        mtimeSafe(fileIndexPath),
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
export function buildMetadataIndex(root) {
    var _a, _b, _c, _d, _e, _f, _g;
    const cached = loadCachedIndex(root);
    if (cached)
        return cached;
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
    // chat_history.jsonl (optional)
    const chatPath = resolveUnderRoot(root, ".rl4", "evidence", CHAT_HISTORY);
    if (fs.existsSync(chatPath)) {
        const raw = readFileSafe(chatPath);
        if (raw) {
            const lines = raw.trim().split("\n").filter(Boolean);
            const messages = [];
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
            if (messages.length > 0) {
                const chatChunks = chunkChat(messages, ".rl4/evidence/chat_history.jsonl", 20);
                chunks.push(...chatChunks);
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
                        t: String((_b = e.t) !== null && _b !== void 0 ? _b : ""),
                        command: String((_c = e.command) !== null && _c !== void 0 ? _c : ""),
                        tool: String((_d = e.tool) !== null && _d !== void 0 ? _d : "unknown"),
                        exit_code: Number((_e = e.exit_code) !== null && _e !== void 0 ? _e : 0),
                        duration_ms: Number((_f = e.duration_ms) !== null && _f !== void 0 ? _f : 0),
                        cwd: String((_g = e.cwd) !== null && _g !== void 0 ? _g : ""),
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
    // code files from content store (snapshots/*.content)
    const fileIndexPath = resolveUnderRoot(root, ".rl4", "snapshots", FILE_INDEX);
    if (fs.existsSync(fileIndexPath)) {
        try {
            const raw = readFileSafe(fileIndexPath);
            if (raw) {
                const fileIndex = JSON.parse(raw);
                const snapshotsDir = resolveUnderRoot(root, ".rl4", "snapshots");
                for (const [filePath, checksums] of Object.entries(fileIndex)) {
                    if (!Array.isArray(checksums) || checksums.length === 0)
                        continue;
                    // Read latest blob (last checksum in array)
                    const latestChecksum = checksums[checksums.length - 1];
                    // Try uncompressed first, then compressed
                    const blobPath = path.join(snapshotsDir, `${latestChecksum}.content`);
                    let content = null;
                    if (fs.existsSync(blobPath)) {
                        content = readFileSafe(blobPath);
                    }
                    if (content) {
                        const codeChunks = chunkCodeFile(filePath, content);
                        chunks.push(...codeChunks);
                    }
                }
            }
        }
        catch {
            // best-effort: code indexing failure doesn't break other sources
        }
    }
    const index = {
        chunks,
        builtAt: new Date().toISOString(),
        root,
    };
    writeCachedIndex(root, index);
    return index;
}
/** Pre-filter chunks by metadata (date, tag, source) */
export function filterChunks(chunks, filters) {
    return chunks.filter((c) => {
        var _a;
        if (filters.source && c.metadata.source !== filters.source)
            return false;
        if (filters.tag && c.metadata.tag !== filters.tag)
            return false;
        const date = (_a = c.metadata.date) !== null && _a !== void 0 ? _a : c.citation.date;
        if (!date)
            return true;
        if (filters.date_from && date < filters.date_from)
            return false;
        if (filters.date_to && date > filters.date_to)
            return false;
        return true;
    });
}
