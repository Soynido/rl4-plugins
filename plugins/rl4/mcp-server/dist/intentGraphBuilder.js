/**
 * intentGraphBuilder — Lightweight IntentGraph builder for MCP server.
 *
 * Ported from extension's IntentGraph.ts. Rebuilds intent_graph.json
 * from intent_chains.jsonl + activity.jsonl when the graph is stale.
 * Includes blob-diff reversal enrichment + suggestion_rejected detection.
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { resolveUnderRoot } from "./safePath.js";
// ── Constants ────────────────────────────────────────────────────────────
const MAX_CHAINS = 50;
const MAX_COUPLINGS = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB read cap
// ── Public API ───────────────────────────────────────────────────────────
/**
 * Check if intent_graph.json is stale (older than latest intent_chains event)
 * and rebuild if needed. Returns true if rebuilt.
 */
export function rebuildIfStale(root) {
    const graphPath = resolveUnderRoot(root, ".rl4", "intent_graph.json");
    const chainsPath = resolveUnderRoot(root, ".rl4", "evidence", "intent_chains.jsonl");
    if (!fs.existsSync(chainsPath))
        return false;
    // Compare modification times
    const chainsMtime = fs.statSync(chainsPath).mtimeMs;
    let graphMtime = 0;
    if (fs.existsSync(graphPath)) {
        graphMtime = fs.statSync(graphPath).mtimeMs;
    }
    if (chainsMtime <= graphMtime)
        return false; // graph is up-to-date
    // Rebuild
    const graph = buildGraph(root);
    writeGraph(graphPath, graph);
    return true;
}
// ── Core Builder ─────────────────────────────────────────────────────────
function buildGraph(root) {
    const chainsPath = resolveUnderRoot(root, ".rl4", "evidence", "intent_chains.jsonl");
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const sessionsPath = resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl");
    // Read events from both sources
    const chainEvents = readJsonlEvents(chainsPath);
    const activityEvents = readActivityAsIntentEvents(activityPath);
    const events = mergeEvents(chainEvents, activityEvents);
    // Build chains
    const chains = buildChains(events);
    // Enrich reversals with blob diff + suggestion_rejected
    const snapshotsDir = resolveUnderRoot(root, ".rl4", "snapshots");
    const suggestionsDir = resolveUnderRoot(root, ".rl4", ".internal", "suggestions");
    const suggestions = loadSuggestions(suggestionsDir);
    for (const chain of chains) {
        if (chain.hot_score >= 0.02) {
            enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions);
        }
    }
    // Sort by hot_score descending
    chains.sort((a, b) => b.hot_score - a.hot_score);
    // Build coupling
    const coupling = buildCoupling(sessionsPath);
    // Summary
    const filesWithReversals = chains.filter(c => c.totalReversals > 0).length;
    const trajectoryCount = new Map();
    for (const c of chains) {
        trajectoryCount.set(c.trajectory, (trajectoryCount.get(c.trajectory) || 0) + 1);
    }
    let dominantTrajectory = null;
    let maxCount = 0;
    for (const [traj, count] of trajectoryCount) {
        if (count > maxCount) {
            maxCount = count;
            dominantTrajectory = traj;
        }
    }
    return {
        chains: chains.slice(0, MAX_CHAINS).map((c) => ({
            file: c.file,
            trajectory: c.trajectory,
            hot_score: c.hot_score,
            versions: c.versions.length,
            reversals: c.totalReversals,
            last_reversal: c.reversals.length > 0 ? (() => {
                var _a, _b, _c;
                const lr = c.reversals[c.reversals.length - 1];
                return {
                    from_v: lr.from_version,
                    to_v: lr.to_version,
                    reverted_lines: lr.reverted_lines,
                    thread_changed: lr.thread_changed,
                    time_gap_hours: lr.time_gap_hours,
                    ...(((_a = lr.hunks) === null || _a === void 0 ? void 0 : _a.length) ? { hunks: lr.hunks } : {}),
                    suggestion_rejected: (_b = lr.suggestion_rejected) !== null && _b !== void 0 ? _b : false,
                    suggestion_hash: (_c = lr.suggestion_hash) !== null && _c !== void 0 ? _c : null,
                };
            })() : null,
            causing_prompts: extractTopCausingPrompts(c),
        })),
        coupling: coupling.slice(0, MAX_COUPLINGS),
        summary: {
            total_files_tracked: chains.length,
            files_with_reversals: filesWithReversals,
            hottest_file: chains.length > 0 ? chains[0].file : null,
            dominant_trajectory: dominantTrajectory,
        },
        built_at: new Date().toISOString(),
    };
}
// ── Event Reading ────────────────────────────────────────────────────────
function readJsonlEvents(filePath) {
    if (!fs.existsSync(filePath))
        return [];
    try {
        const stat = fs.statSync(filePath);
        const readSize = Math.min(stat.size, MAX_FILE_BYTES);
        const startPos = Math.max(0, stat.size - readSize);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, readSize, startPos);
        fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
        const startIdx = startPos > 0 ? 1 : 0;
        const events = [];
        for (let i = startIdx; i < lines.length; i++) {
            try {
                const ev = JSON.parse(lines[i]);
                if ((ev === null || ev === void 0 ? void 0 : ev.file) && (ev === null || ev === void 0 ? void 0 : ev.to_sha256))
                    events.push(ev);
            }
            catch { /* skip */ }
        }
        return events;
    }
    catch {
        return [];
    }
}
function readActivityAsIntentEvents(filePath) {
    var _a, _b;
    if (!fs.existsSync(filePath))
        return [];
    try {
        const stat = fs.statSync(filePath);
        const readSize = Math.min(stat.size, MAX_FILE_BYTES);
        const startPos = Math.max(0, stat.size - readSize);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, readSize, startPos);
        fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
        const startIdx = startPos > 0 ? 1 : 0;
        const events = [];
        const prevSha = new Map();
        for (let i = startIdx; i < lines.length; i++) {
            try {
                const raw = JSON.parse(lines[i]);
                if (!(raw === null || raw === void 0 ? void 0 : raw.path) || raw.kind !== "save" || !raw.sha256 || !raw.t)
                    continue;
                const added = (_a = raw.linesAdded) !== null && _a !== void 0 ? _a : 0;
                const removed = (_b = raw.linesRemoved) !== null && _b !== void 0 ? _b : 0;
                events.push({
                    t: raw.t,
                    file: raw.path,
                    from_sha256: prevSha.get(raw.path) || null,
                    to_sha256: raw.sha256,
                    delta: { linesAdded: added, linesRemoved: removed, netChange: added - removed },
                    intent_signal: classifySignal(added, removed),
                    causing_prompt: null,
                    burst_id: raw.burst_id || null,
                });
                prevSha.set(raw.path, raw.sha256);
            }
            catch { /* skip */ }
        }
        return events;
    }
    catch {
        return [];
    }
}
function classifySignal(added, removed) {
    const total = added + removed;
    if (total === 0)
        return "stable";
    if (removed === 0)
        return "additive";
    if (added === 0)
        return "subtractive";
    if (Math.min(added, removed) / total > 0.3)
        return "rewrite";
    return added > removed ? "additive" : "subtractive";
}
function mergeEvents(chainEvents, activityEvents) {
    const seen = new Set();
    for (const ev of chainEvents)
        seen.add(`${ev.file}|||${ev.to_sha256}`);
    const merged = [...chainEvents];
    for (const ev of activityEvents) {
        if (!seen.has(`${ev.file}|||${ev.to_sha256}`))
            merged.push(ev);
    }
    return merged;
}
function buildChains(events) {
    const byFile = new Map();
    for (const ev of events) {
        const arr = byFile.get(ev.file) || [];
        arr.push(ev);
        byFile.set(ev.file, arr);
    }
    const chains = [];
    for (const [file, fileEvents] of byFile) {
        fileEvents.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
        // Dedup by (sha256 + timestamp) — Fix B
        const seen = new Set();
        const deduped = [];
        for (const ev of fileEvents) {
            const key = `${ev.to_sha256}|${ev.t}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(ev);
            }
        }
        if (deduped.length === 0)
            continue;
        const versions = deduped.map((ev, idx) => ({
            sha256: ev.to_sha256,
            timestamp: ev.t,
            causing_prompt: ev.causing_prompt,
            delta: ev.delta,
            intent_signal: ev.intent_signal,
            version_index: idx,
        }));
        const reversals = detectReversalsMetadata(versions);
        const threadChanges = countThreadChanges(versions);
        const trajectory = classifyTrajectory(versions, reversals);
        const hot_score = computeHotScore(versions.length, reversals.length, threadChanges);
        chains.push({
            file,
            versions,
            events: deduped,
            reversals,
            trajectory,
            hot_score,
            totalReversals: reversals.length,
        });
    }
    return chains;
}
// ── Reversal Detection (Level 1 — metadata) ─────────────────────────────
export const REVERSAL_WINDOW = 3;
export function detectReversalsMetadata(versions) {
    var _a, _b;
    const reversals = [];
    for (let i = 0; i < versions.length - 1; i++) {
        const maxJ = Math.min(i + REVERSAL_WINDOW, versions.length - 1);
        for (let j = i + 1; j <= maxJ; j++) {
            const vi = versions[i];
            const vj = versions[j];
            const score = Math.min(vi.delta.linesAdded, vj.delta.linesRemoved) / Math.max(1, vi.delta.linesAdded);
            if (score > 0.4) {
                // Skip if a narrower reversal from the same origin already exists
                if (reversals.some(r => r.from_version === i && r.to_version < j))
                    continue;
                const threadChanged = !!(((_a = vi.causing_prompt) === null || _a === void 0 ? void 0 : _a.thread_id) && ((_b = vj.causing_prompt) === null || _b === void 0 ? void 0 : _b.thread_id) &&
                    vi.causing_prompt.thread_id !== vj.causing_prompt.thread_id);
                const timeGapMs = new Date(vj.timestamp).getTime() - new Date(vi.timestamp).getTime();
                reversals.push({
                    from_version: i,
                    to_version: j,
                    reverted_lines: Math.min(vi.delta.linesAdded, vj.delta.linesRemoved),
                    reversal_ratio: Math.round(score * 100) / 100,
                    thread_changed: threadChanged,
                    time_gap_hours: Math.round((timeGapMs / (1000 * 60 * 60)) * 100) / 100,
                });
                break; // Take the closest match within the window
            }
        }
    }
    return reversals;
}
// ── Line Range Helpers ────────────────────────────────────────────────────
/** Compute 1-based line ranges that were removed from `before` to produce `after`. */
export function getRevertedLineRange(before, after) {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const ranges = [];
    let bi = 0, ai = 0;
    let rangeStart = -1;
    while (bi < beforeLines.length && ai < afterLines.length) {
        if (beforeLines[bi] === afterLines[ai]) {
            if (rangeStart !== -1) {
                ranges.push({ start: rangeStart, end: bi }); // 1-based end
                rangeStart = -1;
            }
            bi++;
            ai++;
        }
        else {
            if (rangeStart === -1)
                rangeStart = bi + 1; // 1-based start
            bi++;
        }
    }
    if (bi < beforeLines.length) {
        ranges.push({ start: rangeStart !== -1 ? rangeStart : bi + 1, end: beforeLines.length });
    }
    else if (rangeStart !== -1) {
        ranges.push({ start: rangeStart, end: bi });
    }
    return ranges;
}
// ── Blob Diff Enrichment (Level 2) + suggestion_rejected ─────────────────
function readBlob(snapshotsDir, sha256) {
    // Try uncompressed first
    const uncompressed = path.join(snapshotsDir, `${sha256}.content`);
    if (fs.existsSync(uncompressed)) {
        try {
            return fs.readFileSync(uncompressed, "utf8");
        }
        catch { /* fall through */ }
    }
    // Try gzipped
    const compressed = path.join(snapshotsDir, `${sha256}.content.gz`);
    if (fs.existsSync(compressed)) {
        try {
            return zlib.gunzipSync(fs.readFileSync(compressed)).toString("utf8");
        }
        catch { /* skip */ }
    }
    return null;
}
export function simpleHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}
export function enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions) {
    var _a, _b, _c, _d;
    const fileSuggestions = suggestions.get(chain.file) || [];
    for (let i = 0; i < chain.versions.length - 1; i++) {
        const vi = chain.versions[i];
        const vj = chain.versions[i + 1];
        const blobVi = readBlob(snapshotsDir, vi.sha256);
        const blobVj = readBlob(snapshotsDir, vj.sha256);
        if (!blobVi || !blobVj)
            continue;
        // Sliding window lookback: check up to REVERSAL_WINDOW steps back for exact content revert
        let isExactRevert = false;
        for (let k = 1; k <= Math.min(REVERSAL_WINDOW, i); k++) {
            const blobBack = readBlob(snapshotsDir, chain.versions[i - k].sha256);
            if (blobBack !== null && blobVj === blobBack) {
                isExactRevert = true;
                break;
            }
        }
        // Also check hash-chain shortcut (from_sha256 recorded at write time)
        if (!isExactRevert && ((_a = chain.events[i]) === null || _a === void 0 ? void 0 : _a.from_sha256) && vj.sha256 === chain.events[i].from_sha256) {
            isExactRevert = true;
        }
        // Check line-level reversal via delta heuristic
        const existingRev = chain.reversals.find(r => r.from_version === i && r.to_version === i + 1);
        if (isExactRevert || existingRev) {
            const threadChanged = !!(((_b = vi.causing_prompt) === null || _b === void 0 ? void 0 : _b.thread_id) && ((_c = vj.causing_prompt) === null || _c === void 0 ? void 0 : _c.thread_id) &&
                vi.causing_prompt.thread_id !== vj.causing_prompt.thread_id);
            const timeGapMs = new Date(vj.timestamp).getTime() - new Date(vi.timestamp).getTime();
            const timeGapHours = Math.round((timeGapMs / (1000 * 60 * 60)) * 100) / 100;
            // Check suggestion_rejected
            let suggestionRejected;
            let suggestionHash;
            if (fileSuggestions.length > 0 && blobVi) {
                const viHash = simpleHash(blobVi);
                for (const sug of fileSuggestions) {
                    if (sug.tool_name === "Write" && viHash === sug.hash) {
                        suggestionRejected = true;
                        suggestionHash = sug.hash;
                        break;
                    }
                    if (sug.tool_name === "Edit") {
                        if (sug.old_string) {
                            // Hunk-aware: use old_string to find WHERE the edit was applied.
                            // old_string is what existed BEFORE the LLM's edit → find it in the pre-edit blob.
                            // After the edit, sug.content (new_string) occupies that same line range in blobVi.
                            // We then check if that specific line range overlaps with the reverted hunks.
                            const fromSha = (_d = chain.events[i]) === null || _d === void 0 ? void 0 : _d.from_sha256;
                            const preEditBlob = fromSha ? readBlob(snapshotsDir, fromSha) : null;
                            if (preEditBlob) {
                                const oldPos = preEditBlob.indexOf(sug.old_string);
                                if (oldPos !== -1) {
                                    // The edit was at this line range in the pre-edit blob.
                                    // In blobVi (post-edit), sug.content occupies the same starting line.
                                    const editStartLine = preEditBlob.substring(0, oldPos).split("\n").length;
                                    const editEndLine = editStartLine + sug.content.split("\n").length - 1;
                                    const revertedLines = getRevertedLineRange(blobVi, blobVj);
                                    const overlaps = revertedLines.some(h => h.start <= editEndLine && h.end >= editStartLine);
                                    if (overlaps) {
                                        suggestionRejected = true;
                                        suggestionHash = sug.hash;
                                        break;
                                    }
                                }
                            }
                        }
                        else if (blobVi.includes(sug.content)) {
                            // Legacy fallback for old suggestions without old_string
                            suggestionRejected = true;
                            suggestionHash = sug.hash;
                            break;
                        }
                    }
                }
            }
            if (existingRev) {
                if (isExactRevert) {
                    existingRev.reverted_lines = blobVi.split("\n").length;
                    existingRev.reversal_ratio = 1.0;
                }
                if (suggestionRejected) {
                    existingRev.suggestion_rejected = true;
                    existingRev.suggestion_hash = suggestionHash;
                }
            }
            else if (isExactRevert) {
                chain.reversals.push({
                    from_version: i,
                    to_version: i + 1,
                    reverted_lines: blobVi.split("\n").length,
                    reversal_ratio: 1.0,
                    thread_changed: threadChanged,
                    time_gap_hours: timeGapHours,
                    ...(suggestionRejected ? { suggestion_rejected: true, suggestion_hash: suggestionHash } : {}),
                });
            }
        }
    }
    chain.reversals.sort((a, b) => a.from_version - b.from_version);
    chain.totalReversals = chain.reversals.length;
    // Recompute trajectory + hot_score
    const threadChanges = countThreadChanges(chain.versions);
    chain.trajectory = classifyTrajectory(chain.versions, chain.reversals);
    chain.hot_score = computeHotScore(chain.versions.length, chain.totalReversals, threadChanges);
}
// ── Suggestions ──────────────────────────────────────────────────────────
function loadSuggestions(dir) {
    const map = new Map();
    try {
        if (!fs.existsSync(dir))
            return map;
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
            try {
                const obj = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
                if (obj.file && obj.tool_input_hash && obj.suggested_content) {
                    const arr = map.get(obj.file) || [];
                    arr.push({
                        hash: obj.tool_input_hash,
                        content: obj.suggested_content,
                        old_string: obj.old_string || undefined,
                        intervention_id: obj.intervention_id || file.replace(".json", ""),
                        tool_name: obj.tool_name || "unknown",
                    });
                    map.set(obj.file, arr);
                }
            }
            catch { /* skip */ }
        }
    }
    catch { /* dir missing */ }
    return map;
}
// ── Trajectory ───────────────────────────────────────────────────────────
function classifyTrajectory(versions, reversals) {
    if (versions.length < 2)
        return "linear";
    if (reversals.length === 0) {
        const additive = versions.filter(v => v.intent_signal === "additive").length;
        return additive >= versions.length * 0.5 ? "linear" : "exploring";
    }
    if (reversals.length > 2) {
        const signals = versions.map(v => v.intent_signal);
        let alternations = 0;
        for (let i = 1; i < signals.length; i++) {
            if ((signals[i] === "additive" && signals[i - 1] === "subtractive") ||
                (signals[i] === "subtractive" && signals[i - 1] === "additive"))
                alternations++;
        }
        if (alternations >= 2)
            return "oscillating";
    }
    if (reversals.length > 0 && versions.length >= 4) {
        const threshold = Math.floor(versions.length * 0.7);
        const lateReversals = reversals.filter(r => r.to_version >= threshold);
        if (lateReversals.length === 0) {
            const lateVersions = versions.slice(threshold);
            const stable = lateVersions.filter(v => v.intent_signal === "additive" || v.intent_signal === "stable").length;
            if (stable >= lateVersions.length * 0.6)
                return "converging";
        }
    }
    const rewrites = versions.filter(v => v.intent_signal === "rewrite").length;
    if (rewrites >= versions.length * 0.4)
        return "exploring";
    return "converging";
}
// ── Hot Score ────────────────────────────────────────────────────────────
function computeHotScore(totalVersions, totalReversals, threadChanges) {
    const score = (Math.min(totalVersions, 10) / 10) * 0.3 +
        (totalReversals / Math.max(1, totalVersions)) * 0.4 +
        (threadChanges / Math.max(1, totalVersions)) * 0.3;
    return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}
function countThreadChanges(versions) {
    var _a, _b;
    let changes = 0;
    for (let i = 1; i < versions.length; i++) {
        const prev = (_a = versions[i - 1].causing_prompt) === null || _a === void 0 ? void 0 : _a.thread_id;
        const curr = (_b = versions[i].causing_prompt) === null || _b === void 0 ? void 0 : _b.thread_id;
        if (prev && curr && prev !== curr)
            changes++;
    }
    return changes;
}
function extractTopCausingPrompts(chain) {
    var _a, _b;
    const refs = new Set();
    for (const rev of chain.reversals) {
        const v = chain.versions[rev.from_version];
        if ((_a = v === null || v === void 0 ? void 0 : v.causing_prompt) === null || _a === void 0 ? void 0 : _a.chat_ref)
            refs.add(v.causing_prompt.chat_ref);
        if (refs.size >= 5)
            break;
    }
    for (const v of chain.versions) {
        if ((_b = v.causing_prompt) === null || _b === void 0 ? void 0 : _b.chat_ref)
            refs.add(v.causing_prompt.chat_ref);
        if (refs.size >= 5)
            break;
    }
    return [...refs];
}
// ── Coupling ─────────────────────────────────────────────────────────────
function buildCoupling(sessionsPath) {
    if (!fs.existsSync(sessionsPath))
        return [];
    try {
        const stat = fs.statSync(sessionsPath);
        const readSize = Math.min(stat.size, 100 * 1024);
        const startPos = Math.max(0, stat.size - readSize);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(sessionsPath, "r");
        fs.readSync(fd, buf, 0, readSize, startPos);
        fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
        const startIdx = startPos > 0 ? 1 : 0;
        const map = new Map();
        for (let i = startIdx; i < lines.length; i++) {
            try {
                const burst = JSON.parse(lines[i]);
                if (!Array.isArray(burst.files) || burst.files.length < 2)
                    continue;
                const files = burst.files.slice(0, 10);
                for (let a = 0; a < files.length; a++) {
                    for (let b = a + 1; b < files.length; b++) {
                        const key = [files[a], files[b]].sort().join("|||");
                        map.set(key, (map.get(key) || 0) + 1);
                    }
                }
            }
            catch { /* skip */ }
        }
        const couplings = [];
        for (const [key, count] of map) {
            if (count > 2) {
                const [a, b] = key.split("|||");
                couplings.push({ files: [a, b], co_modifications: count });
            }
        }
        couplings.sort((a, b) => b.co_modifications - a.co_modifications);
        return couplings;
    }
    catch {
        return [];
    }
}
// ── Write ────────────────────────────────────────────────────────────────
function writeGraph(graphPath, graph) {
    try {
        const dir = path.dirname(graphPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${graphPath}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(graph, null, 2), "utf8");
        fs.renameSync(tmpPath, graphPath);
    }
    catch (err) {
        console.error("[RL4 MCP] Failed to write intent_graph.json:", err);
    }
}
