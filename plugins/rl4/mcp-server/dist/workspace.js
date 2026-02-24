/**
 * RL4 workspace paths and file reads.
 * Workspace root: RL4_WORKSPACE_ROOT env, or first CLI arg, or cwd.
 * Uses safe path resolution to prevent traversal (SAST path.join finding).
 */
import * as fs from "fs";
import * as path from "path";
import { resolveUnderRoot } from "./safePath.js";
import { stableLessonId } from "./causal_engine.js";
export function getWorkspaceRoot() {
    var _a;
    const fromEnv = (_a = process.env.RL4_WORKSPACE_ROOT) !== null && _a !== void 0 ? _a : process.env.CURSOR_WORKSPACE_DIR;
    if (fromEnv)
        return path.resolve(fromEnv);
    const fromArg = process.argv[2];
    if (fromArg)
        return path.resolve(fromArg);
    return process.cwd();
}
const PATHS = {
    evidence: ".rl4/evidence.md",
    timeline: ".rl4/timeline.md",
    decisionsRl4: ".rl4/evidence/decisions.jsonl",
    decisionsReasoning: ".reasoning_rl4/cognitive/decisions.jsonl",
    intentGraph: ".rl4/intent_graph.json",
};
export function getEvidencePath(root) {
    return resolveUnderRoot(root, ".rl4", "evidence.md");
}
export function getTimelinePath(root) {
    return resolveUnderRoot(root, ".rl4", "timeline.md");
}
export function getDecisionsPath(root) {
    const rl4 = resolveUnderRoot(root, ".rl4", "evidence", "decisions.jsonl");
    if (fs.existsSync(rl4))
        return rl4;
    const reasoning = resolveUnderRoot(root, ".reasoning_rl4", "cognitive", "decisions.jsonl");
    if (fs.existsSync(reasoning))
        return reasoning;
    return rl4; // default to .rl4 path
}
export function getIntentGraphPath(root) {
    return resolveUnderRoot(root, ".rl4", "intent_graph.json");
}
/** Read MIG intent_graph.json. Returns formatted string or message if missing. */
export function readIntentGraph(root) {
    const content = readFileSafe(getIntentGraphPath(root));
    if (!content)
        return "[No intent_graph.json found. MIG is built by the extension (IntentGraphBuilder) after file activity.]";
    return `Source: .rl4/intent_graph.json\n\n${content}`;
}
export function readFileSafe(filePath, encoding = "utf-8") {
    try {
        if (!fs.existsSync(filePath))
            return null;
        return fs.readFileSync(filePath, encoding);
    }
    catch {
        return null;
    }
}
export function readEvidence(root) {
    const content = readFileSafe(getEvidencePath(root));
    if (!content)
        return "[No evidence.md found. Install RL4 extension and run the workspace to generate .rl4/evidence.md]";
    return `Source: .rl4/evidence.md\n\n${content}`;
}
export function readTimeline(root) {
    const content = readFileSafe(getTimelinePath(root));
    if (!content)
        return "[No timeline.md found. Install RL4 extension and run the workspace to generate .rl4/timeline.md]";
    return `Source: .rl4/timeline.md\n\n${content}`;
}
export function readDecisions(root) {
    var _a, _b, _c, _d, _e;
    const decisionsPath = getDecisionsPath(root);
    const raw = readFileSafe(decisionsPath);
    if (!raw)
        return [];
    const lines = raw.trim().split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
        try {
            const d = JSON.parse(line);
            out.push({
                id: String((_a = d.id) !== null && _a !== void 0 ? _a : ""),
                intent_text: String((_b = d.intent_text) !== null && _b !== void 0 ? _b : ""),
                chosen_option: String((_c = d.chosen_option) !== null && _c !== void 0 ? _c : ""),
                confidence_gate: String((_d = d.confidence_gate) !== null && _d !== void 0 ? _d : ""),
                isoTimestamp: String((_e = d.isoTimestamp) !== null && _e !== void 0 ? _e : ""),
                source: "decisions.jsonl",
            });
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
/**
 * Aggregate decisions from 3 real sources (+ legacy decisions.jsonl):
 * 1. CRE interventions (.rl4/.internal/cre_interventions.jsonl) — each is a micro-decision
 * 2. Intent Graph reversals (.rl4/intent_graph.json) — implicit decision changes
 * 3. Timeline [DECISION] entries (.rl4/timeline.md) — LLM-written decisions
 * Returns unified DecisionSummary[] sorted by timestamp DESC.
 */
export function aggregateDecisions(root) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const all = [];
    // Source 0: Legacy decisions.jsonl (keep backward compat)
    all.push(...readDecisions(root));
    // Source 1: CRE interventions
    const crePath = resolveUnderRoot(root, ".rl4", ".internal", "cre_interventions.jsonl");
    const creRaw = readFileSafe(crePath);
    if (creRaw) {
        const lines = creRaw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const iv = JSON.parse(line);
                const selectedLessons = iv.selected_lessons;
                const topLesson = selectedLessons === null || selectedLessons === void 0 ? void 0 : selectedLessons[0];
                const lessonCount = (_a = selectedLessons === null || selectedLessons === void 0 ? void 0 : selectedLessons.length) !== null && _a !== void 0 ? _a : 0;
                const outcome = String((_b = iv.outcome) !== null && _b !== void 0 ? _b : "pending");
                const confidence = outcome === "accepted" ? "high"
                    : outcome === "rejected" ? "low"
                        : "medium";
                all.push({
                    id: String((_c = iv.intervention_id) !== null && _c !== void 0 ? _c : ""),
                    intent_text: `CRE intervention on ${(_d = iv.file) !== null && _d !== void 0 ? _d : "unknown"}: ${lessonCount} lesson(s) injected`,
                    chosen_option: topLesson
                        ? `Top lesson: [${topLesson.type}] score=${(_f = (_e = topLesson.crs_score) === null || _e === void 0 ? void 0 : _e.toFixed(2)) !== null && _f !== void 0 ? _f : "?"}`
                        : "No lessons selected",
                    confidence_gate: confidence,
                    isoTimestamp: String((_g = iv.timestamp) !== null && _g !== void 0 ? _g : ""),
                    source: "cre_intervention",
                });
            }
            catch { /* skip malformed */ }
        }
    }
    // Source 2: Intent Graph reversals
    const graphData = readIntentGraphData(root);
    if (graphData && Array.isArray(graphData.chains)) {
        for (const chain of graphData.chains) {
            if (chain.reversals > 0 && chain.last_reversal) {
                all.push({
                    id: `reversal-${chain.file.replace(/[^a-zA-Z0-9]/g, "-")}`,
                    intent_text: `Reversal on ${chain.file}: ${chain.reversals} reversal(s), ${chain.last_reversal.reverted_lines} lines reverted`,
                    chosen_option: `Reverted v${chain.last_reversal.from_v} → v${chain.last_reversal.to_v} (gap: ${chain.last_reversal.time_gap_hours.toFixed(1)}h)`,
                    confidence_gate: chain.reversals >= 3 ? "low" : chain.reversals >= 2 ? "medium" : "high",
                    isoTimestamp: graphData.built_at || "",
                    source: "intent_graph_reversal",
                });
            }
        }
    }
    // Source 3: Timeline [DECISION] entries
    const timelineContent = readFileSafe(getTimelinePath(root));
    if (timelineContent) {
        const decisionRegex = /^-\s*(?:\*\*)?(?:\[DECISION\])(?:\*\*)?\s*(.+?)(?:\s*\[([^\]]+)\])?\s*$/gm;
        let match;
        let currentDate = "";
        // Track current date context from timeline headers
        for (const line of timelineContent.split("\n")) {
            const dateMatch = line.match(/^##\s+.*?(\d{4}-\d{2}-\d{2})/);
            if (dateMatch)
                currentDate = dateMatch[1];
        }
        // Reset and extract decisions
        decisionRegex.lastIndex = 0;
        while ((match = decisionRegex.exec(timelineContent)) !== null) {
            const text = match[1].trim();
            const refId = match[2] || "";
            // Find the nearest date header above this match
            const before = timelineContent.substring(0, match.index);
            const dateHeaders = before.match(/##\s+.*?(\d{4}-\d{2}-\d{2})/g);
            const nearestDate = dateHeaders
                ? ((_h = dateHeaders[dateHeaders.length - 1].match(/(\d{4}-\d{2}-\d{2})/)) === null || _h === void 0 ? void 0 : _h[1]) || currentDate
                : currentDate;
            all.push({
                id: refId || `timeline-dec-${match.index}`,
                intent_text: text,
                chosen_option: "(from timeline)",
                confidence_gate: "medium",
                isoTimestamp: nearestDate ? `${nearestDate}T00:00:00Z` : "",
                source: "timeline",
            });
        }
    }
    // Sort by timestamp DESC (most recent first)
    all.sort((a, b) => (b.isoTimestamp || "").localeCompare(a.isoTimestamp || ""));
    return all;
}
/**
 * Load lessons for a specific file from intent_graph.json + skills.mdc + decisions.
 * Used by suggest_edit to inject context before editing.
 */
export function loadLessonsForFile(root, relPath) {
    var _a, _b;
    const lessons = {
        reversals: [],
        hot_score: 0,
        trajectory: 'linear',
        avoid_patterns: [],
        coupled_files: [],
        past_decisions: [],
        chat_lessons: [],
    };
    const fileName = relPath.split('/').pop() || relPath;
    // 1. Intent graph data
    let foundInGraph = false;
    const graphContent = readFileSafe(resolveUnderRoot(root, ".rl4", "snapshots", "intent_graph.json"))
        || readFileSafe(resolveUnderRoot(root, ".rl4", "intent_graph.json"));
    if (graphContent) {
        try {
            const graph = JSON.parse(graphContent);
            // Find file in chains or hot_files
            const chains = graph.chains || graph.hot_files || [];
            const entry = chains.find((c) => { var _a; return c.file === relPath || ((_a = c.file) === null || _a === void 0 ? void 0 : _a.endsWith('/' + relPath)); });
            if (entry) {
                foundInGraph = true;
                lessons.hot_score = (_a = entry.hot_score) !== null && _a !== void 0 ? _a : 0;
                lessons.trajectory = (_b = entry.trajectory) !== null && _b !== void 0 ? _b : 'linear';
                if (entry.last_reversal) {
                    lessons.reversals.push(entry.last_reversal);
                }
            }
            // Coupling from graph clusters
            const coupling = graph.coupling_clusters || graph.coupling || [];
            for (const cluster of coupling) {
                const files = cluster.files || [];
                if (files.some((f) => f === relPath || f.endsWith('/' + relPath))) {
                    lessons.coupled_files.push(...files.filter((f) => f !== relPath && !f.endsWith('/' + relPath)));
                }
            }
        }
        catch { /* malformed graph */ }
    }
    // 1b. Fallback: compute hot_score + coupling from activity.jsonl when intent_graph misses this file
    if (!foundInGraph) {
        try {
            const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
            const activityRaw = readFileSafe(activityPath);
            if (activityRaw) {
                const lines = activityRaw.split('\n').filter(Boolean);
                let saveCount = 0;
                const coEdited = new Map(); // files saved in same 5-min window
                const timestamps = [];
                for (const line of lines) {
                    try {
                        const ev = JSON.parse(line);
                        const fp = ev.file || ev.path || '';
                        if (!fp.includes(fileName) && fp !== relPath && !fp.endsWith('/' + relPath))
                            continue;
                        saveCount++;
                        const ts = ev.ts || ev.timestamp ? new Date(ev.ts || ev.timestamp).getTime() : 0;
                        if (ts)
                            timestamps.push(ts);
                    }
                    catch { /* skip malformed */ }
                }
                // Compute hot_score from save frequency (normalized 0-1)
                if (saveCount > 0) {
                    lessons.hot_score = Math.min(1, saveCount / 100); // 100 saves = max hot
                    // Determine trajectory from timestamps
                    if (timestamps.length >= 3) {
                        const sorted = timestamps.sort((a, b) => a - b);
                        const recent = sorted.slice(-Math.ceil(sorted.length / 3));
                        const older = sorted.slice(0, Math.ceil(sorted.length / 3));
                        const recentDensity = recent.length / (Math.max(1, (recent[recent.length - 1] - recent[0]) / 3600000));
                        const olderDensity = older.length / (Math.max(1, (older[older.length - 1] - older[0]) / 3600000));
                        if (recentDensity > olderDensity * 1.5)
                            lessons.trajectory = 'accelerating';
                        else if (recentDensity < olderDensity * 0.5)
                            lessons.trajectory = 'converging';
                        else
                            lessons.trajectory = 'linear';
                    }
                }
                // Compute co-edited coupling: find files saved within 5 min of this file
                if (timestamps.length > 0) {
                    const WINDOW_MS = 5 * 60 * 1000;
                    for (const line of lines) {
                        try {
                            const ev = JSON.parse(line);
                            const fp = ev.file || ev.path || '';
                            if (fp.includes(fileName) || fp === relPath || fp.endsWith('/' + relPath))
                                continue;
                            const ts = ev.ts || ev.timestamp ? new Date(ev.ts || ev.timestamp).getTime() : 0;
                            if (!ts)
                                continue;
                            // Check if this event is within WINDOW_MS of any target file event
                            for (const t of timestamps) {
                                if (Math.abs(ts - t) <= WINDOW_MS) {
                                    coEdited.set(fp, (coEdited.get(fp) || 0) + 1);
                                    break;
                                }
                            }
                        }
                        catch { /* skip */ }
                    }
                    // Top coupled files (co-edited >= 3 times)
                    const coupled = [...coEdited.entries()]
                        .filter(([, count]) => count >= 3)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([f]) => f);
                    if (coupled.length > 0 && lessons.coupled_files.length === 0) {
                        lessons.coupled_files.push(...coupled);
                    }
                }
            }
        }
        catch { /* non-critical */ }
    }
    // 2. Skills.mdc AVOID patterns — match AVOID, NEVER, NE JAMAIS, DONT, DO NOT
    const skillsContent = readFileSafe(resolveUnderRoot(root, ".rl4", "skills.mdc"));
    if (skillsContent) {
        const lines = skillsContent.split('\n');
        let inAvoidSection = false;
        for (const line of lines) {
            const trimmed = line.trim();
            // Detect section headers
            if (/^##?\s/.test(trimmed)) {
                inAvoidSection = /AVOID|NEVER|NE JAMAIS|DONT|DO NOT|REFAIRE/i.test(trimmed);
                continue;
            }
            // Capture lines in AVOID sections that are bullet points
            if (inAvoidSection && /^[-*]\s/.test(trimmed)) {
                // Include if: mentions this file OR is a generic rule (no file-specific filter)
                if (trimmed.includes(fileName) || trimmed.includes(relPath)) {
                    lessons.avoid_patterns.push(trimmed.replace(/^[-*]\s*/, ''));
                }
                else if (lessons.avoid_patterns.length < 10) {
                    // Include generic AVOID patterns (up to 10, as context)
                    lessons.avoid_patterns.push(trimmed.replace(/^[-*]\s*/, ''));
                }
            }
        }
    }
    // 3. Decisions related to this file (from all aggregated sources)
    const decisions = aggregateDecisions(root);
    for (const d of decisions) {
        if (d.intent_text.includes(relPath) || d.chosen_option.includes(relPath)
            || d.intent_text.includes(fileName) || d.chosen_option.includes(fileName)) {
            lessons.past_decisions.push(`${d.intent_text} → ${d.chosen_option}`);
        }
    }
    // 4. Chat lessons — find discussions mentioning this file
    try {
        const chatPath = resolveUnderRoot(root, ".rl4", "evidence", "chat_threads.jsonl");
        const chatRaw = readFileSafe(chatPath);
        if (chatRaw) {
            const chatLines = chatRaw.split('\n').filter(Boolean);
            for (const line of chatLines) {
                try {
                    const thread = JSON.parse(line);
                    const title = thread.title || '';
                    const topics = thread.topics || [];
                    const allText = title + ' ' + topics.join(' ');
                    if (allText.includes(fileName) || allText.includes(relPath)) {
                        lessons.chat_lessons.push(`[${thread.source || 'chat'}] ${title}`);
                    }
                }
                catch { /* skip */ }
            }
            // Limit to 5 most recent
            if (lessons.chat_lessons.length > 5) {
                lessons.chat_lessons = lessons.chat_lessons.slice(-5);
            }
        }
    }
    catch { /* non-critical */ }
    return lessons;
}
/**
 * Append an agent action to agent_actions.jsonl for proof chain.
 */
export function appendAgentAction(root, action) {
    const actionsPath = resolveUnderRoot(root, ".rl4", "evidence", "agent_actions.jsonl");
    const dir = path.dirname(actionsPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(actionsPath, JSON.stringify(action) + '\n');
}
/** Read causal_links.jsonl → array of CausalLink */
export function readCausalLinks(root) {
    const p = resolveUnderRoot(root, ".rl4", ".internal", "causal_links.jsonl");
    const raw = readFileSafe(p);
    if (!raw)
        return [];
    return raw.trim().split("\n").filter(Boolean).map(line => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    }).filter((x) => x !== null);
}
/** Read sessions.jsonl → array of BurstSession (only burst events, not agent_stop) */
export function readBurstSessions(root) {
    const p = resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl");
    const raw = readFileSafe(p);
    if (!raw)
        return [];
    return raw.trim().split("\n").filter(Boolean).map(line => {
        try {
            const obj = JSON.parse(line);
            if (!obj.burst_id || obj.event)
                return null; // skip agent_stop events
            return obj;
        }
        catch {
            return null;
        }
    }).filter((x) => x !== null);
}
/** Read intent_graph.json → typed structure */
export function readIntentGraphData(root) {
    const content = readFileSafe(resolveUnderRoot(root, ".rl4", "snapshots", "intent_graph.json"))
        || readFileSafe(resolveUnderRoot(root, ".rl4", "intent_graph.json"));
    if (!content)
        return null;
    try {
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Tail-read last N lines from a JSONL file using reverse buffer scan.
 * O(bufferSize) instead of O(fileSize). Handles partial lines and invalid JSON.
 */
function tailReadJsonlLines(filePath, maxLines, bufferSize = 256 * 1024) {
    let fd;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0)
            return [];
        fd = fs.openSync(filePath, 'r');
        const readSize = Math.min(bufferSize, stat.size);
        const buf = Buffer.alloc(readSize);
        const bytesRead = fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        const text = buf.slice(0, bytesRead).toString('utf-8');
        const rawLines = text.split('\n').filter(l => l.trim().length > 0);
        // Drop first line if we started mid-file (could be partial)
        if (readSize < stat.size && rawLines.length > 0) {
            rawLines.shift();
        }
        const tail = rawLines.slice(-maxLines);
        const out = [];
        for (const line of tail) {
            try {
                out.push(JSON.parse(line));
            }
            catch { /* skip malformed */ }
        }
        return out;
    }
    catch {
        return [];
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* ignore */ }
        }
    }
}
/** Read activity.jsonl (last 200 events) and compute average days between saves for a file */
export function computeAvgDaysBetweenSaves(root, relPath) {
    var _a;
    const p = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const events = tailReadJsonlLines(p, 200);
    const timestamps = [];
    for (const obj of events) {
        if (obj.kind !== "save")
            continue;
        if (relPath && obj.path !== relPath && !((_a = obj.path) === null || _a === void 0 ? void 0 : _a.endsWith("/" + relPath)))
            continue;
        const t = new Date(obj.t).getTime();
        if (!isNaN(t))
            timestamps.push(t);
    }
    if (timestamps.length < 2)
        return 7;
    timestamps.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) {
        gaps.push((timestamps[i] - timestamps[i - 1]) / (24 * 3600000));
    }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return Math.max(0.1, avg); // min 0.1 days
}
/** Read activity.jsonl → last activity timestamp (ISO string) */
export function getLastActivityTimestamp(root) {
    const p = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const events = tailReadJsonlLines(p, 5);
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].t)
            return events[i].t;
    }
    return null;
}
/** Load CRE state from .rl4/.internal/cre_state.json */
export function loadCREState(root) {
    const p = resolveUnderRoot(root, ".rl4", ".internal", "cre_state.json");
    const raw = readFileSafe(p);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** Save CRE state to .rl4/.internal/cre_state.json */
export function saveCREState(root, state) {
    const p = resolveUnderRoot(root, ".rl4", ".internal", "cre_state.json");
    const dir = path.dirname(p);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
}
/** Read recent burst sessions (last N) */
export function readRecentBursts(root, count) {
    const all = readBurstSessions(root);
    return all.slice(-count);
}
export function formatDecisionsForResource(decisions) {
    if (decisions.length === 0)
        return "Source: decisions.jsonl\n\n[No decisions found.]";
    const header = "Source: .rl4/evidence/decisions.jsonl or .reasoning_rl4/cognitive/decisions.jsonl\n\n";
    const body = decisions
        .map((d) => `- [${d.id}] ${d.isoTimestamp} | ${d.intent_text} → ${d.chosen_option} (gate: ${d.confidence_gate})`)
        .join("\n");
    return header + body;
}
// ── Workspace-global lesson extraction (for one-click snapshot CRE phase) ────
/**
 * Build workspace-wide lessons from all data sources (not file-specific).
 * Used by the one-click snapshot to score and surface top CRE insights.
 */
export function buildWorkspaceLessons(root) {
    const lessons = [];
    const now = new Date().toISOString();
    // 1. AVOID patterns from skills.mdc
    const skillsContent = readFileSafe(resolveUnderRoot(root, ".rl4", "skills.mdc"));
    if (skillsContent) {
        for (const line of skillsContent.split("\n")) {
            const trimmed = line.replace(/^-\s*/, "").trim();
            if (!trimmed.includes("AVOID"))
                continue;
            const text = trimmed.replace(/^AVOID:\s*/i, "").trim();
            if (text.length < 5)
                continue;
            lessons.push({
                id: stableLessonId("AVOID", "skills.mdc", text),
                type: "AVOID",
                text,
                origin_file: "skills.mdc",
                origin_prompt_ids: [],
                evidence_refs: [".rl4/skills.mdc"],
                first_seen: now,
                last_seen: now,
            });
        }
    }
    // 2. Intent graph: REVERSAL, COUPLING, HOTSPOT
    const graphData = readIntentGraphData(root);
    if (graphData && Array.isArray(graphData.chains)) {
        for (const chain of graphData.chains) {
            // REVERSAL lessons
            if (chain.reversals > 0 && chain.last_reversal) {
                const text = `${chain.file}: ${chain.reversals} reversal(s), last reverted ${chain.last_reversal.reverted_lines} lines (gap: ${chain.last_reversal.time_gap_hours.toFixed(1)}h)`;
                lessons.push({
                    id: stableLessonId("REVERSAL", chain.file, text),
                    type: "REVERSAL",
                    text,
                    origin_file: chain.file,
                    origin_prompt_ids: chain.causing_prompts || [],
                    evidence_refs: [".rl4/intent_graph.json"],
                    first_seen: now,
                    last_seen: now,
                });
            }
            // HOTSPOT lessons (high edit count)
            if (chain.hot_score >= 5) {
                const text = `${chain.file}: hot_score=${chain.hot_score}, ${chain.versions} versions, trajectory=${chain.trajectory}`;
                lessons.push({
                    id: stableLessonId("HOTSPOT", chain.file, text),
                    type: "HOTSPOT",
                    text,
                    origin_file: chain.file,
                    origin_prompt_ids: [],
                    evidence_refs: [".rl4/intent_graph.json"],
                    first_seen: now,
                    last_seen: now,
                });
            }
        }
        // COUPLING lessons (co_modifications > 3)
        for (const pair of graphData.coupling) {
            if (pair.co_modifications <= 3 || pair.files.length < 2)
                continue;
            const text = `${pair.files[0]} ↔ ${pair.files[1]}: ${pair.co_modifications} co-modifications`;
            lessons.push({
                id: stableLessonId("COUPLING", pair.files[0], text),
                type: "COUPLING",
                text,
                origin_file: pair.files[0],
                origin_prompt_ids: [],
                evidence_refs: [".rl4/intent_graph.json"],
                first_seen: now,
                last_seen: now,
            });
        }
    }
    // 3. DECISION lessons from aggregated sources (CRE + reversals + timeline + legacy)
    const decisions = aggregateDecisions(root);
    for (const d of decisions) {
        if (!d.intent_text)
            continue;
        const text = `${d.intent_text} → ${d.chosen_option} (${d.confidence_gate})`;
        const src = d.source || "decisions.jsonl";
        lessons.push({
            id: stableLessonId("DECISION", d.id || src, text),
            type: "DECISION",
            text,
            origin_file: d.id || src,
            origin_prompt_ids: [],
            evidence_refs: [src === "cre_intervention" ? ".rl4/.internal/cre_interventions.jsonl"
                    : src === "intent_graph_reversal" ? ".rl4/intent_graph.json"
                        : src === "timeline" ? ".rl4/timeline.md"
                            : ".rl4/evidence/decisions.jsonl"],
            first_seen: d.isoTimestamp || now,
            last_seen: d.isoTimestamp || now,
        });
    }
    return lessons;
}
