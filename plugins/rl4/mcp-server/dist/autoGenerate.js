/**
 * Auto-generate timeline.md and evidence.md from JSONL evidence files.
 * Pure mechanical truth — zero LLM, zero hallucination.
 *
 * Sources:
 *   - sessions.jsonl   (bursts: files, pattern, duration)
 *   - activity.jsonl    (file saves: path, sha256, linesAdded/Removed)
 *   - chat_threads.jsonl (thread summaries: title, count, timestamps)
 *   - chat_history.jsonl (message count only — not read line by line)
 *   - file_index.json   (content store: file → checksum)
 */
import * as fs from "fs";
import * as path from "path";
import { resolveUnderRoot } from "./safePath.js";
// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------
function readJsonl(filePath, requiredKey) {
    if (!fs.existsSync(filePath))
        return [];
    const content = fs.readFileSync(filePath, "utf8");
    const items = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{"))
            continue;
        try {
            const obj = JSON.parse(trimmed);
            if (requiredKey && !(requiredKey in obj))
                continue;
            items.push(obj);
        }
        catch { /* skip malformed */ }
    }
    return items;
}
function countLines(filePath) {
    if (!fs.existsSync(filePath))
        return 0;
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(l => l.trim() && l.trim().startsWith("{")).length;
}
// ---------------------------------------------------------------------------
// Session clustering: group bursts < 30min apart into work sessions
// ---------------------------------------------------------------------------
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 min gap = new session
function clusterBurstsIntoSessions(bursts, dayEvents, dayThreads) {
    var _a, _b, _c;
    if (bursts.length === 0)
        return [];
    const sorted = [...bursts].sort((a, b) => a.t.localeCompare(b.t));
    const sessions = [];
    let current = {
        start: sorted[0].t,
        end: sorted[0].t,
        bursts: [sorted[0]],
        files: new Set(sorted[0].files),
        patterns: new Map([[sorted[0].pattern.type, 1]]),
        totalEvents: sorted[0].events_count,
        linesAdded: 0,
        linesRemoved: 0,
        threads: [],
    };
    for (let i = 1; i < sorted.length; i++) {
        const gap = new Date(sorted[i].t).getTime() - new Date(current.end).getTime();
        if (gap > SESSION_GAP_MS) {
            sessions.push(current);
            current = {
                start: sorted[i].t,
                end: sorted[i].t,
                bursts: [sorted[i]],
                files: new Set(sorted[i].files),
                patterns: new Map([[sorted[i].pattern.type, 1]]),
                totalEvents: sorted[i].events_count,
                linesAdded: 0,
                linesRemoved: 0,
                threads: [],
            };
        }
        else {
            current.end = sorted[i].t;
            current.bursts.push(sorted[i]);
            for (const f of sorted[i].files)
                current.files.add(f);
            current.patterns.set(sorted[i].pattern.type, ((_a = current.patterns.get(sorted[i].pattern.type)) !== null && _a !== void 0 ? _a : 0) + 1);
            current.totalEvents += sorted[i].events_count;
        }
    }
    sessions.push(current);
    // Enrich with line counts from activity.jsonl
    for (const session of sessions) {
        const sStart = new Date(session.start).getTime();
        const sEnd = new Date(session.end).getTime() + SESSION_GAP_MS; // include trailing events
        for (const ev of dayEvents) {
            const evTime = new Date(ev.t).getTime();
            if (evTime >= sStart && evTime <= sEnd) {
                session.linesAdded += (_b = ev.linesAdded) !== null && _b !== void 0 ? _b : 0;
                session.linesRemoved += (_c = ev.linesRemoved) !== null && _c !== void 0 ? _c : 0;
            }
        }
    }
    // Correlate with chat threads by timestamp overlap
    for (const session of sessions) {
        const sStart = new Date(session.start).getTime();
        const sEnd = new Date(session.end).getTime() + SESSION_GAP_MS;
        for (const thread of dayThreads) {
            if (thread.lastMs >= sStart && thread.firstMs <= sEnd) {
                session.threads.push(thread);
            }
        }
    }
    return sessions;
}
// ---------------------------------------------------------------------------
// Group data by day
// ---------------------------------------------------------------------------
function groupByDay(bursts, events, threads) {
    var _a, _b, _c, _d, _e, _f;
    const burstsByDay = new Map();
    for (const b of bursts) {
        const day = b.t.slice(0, 10);
        if (!burstsByDay.has(day))
            burstsByDay.set(day, []);
        burstsByDay.get(day).push(b);
    }
    const eventsByDay = new Map();
    for (const e of events) {
        const day = e.t.slice(0, 10);
        if (!eventsByDay.has(day))
            eventsByDay.set(day, []);
        eventsByDay.get(day).push(e);
    }
    // Index threads by day — assign to the day of LAST message (most relevant day)
    // Filter out threads with invalid timestamps (0, negative, or before 2020)
    const MIN_VALID_MS = new Date("2020-01-01").getTime();
    const threadsByDay = new Map();
    for (const t of threads) {
        if (!t.firstMs || !t.lastMs || t.firstMs < MIN_VALID_MS || t.lastMs < MIN_VALID_MS)
            continue;
        const lastDay = new Date(t.lastMs).toISOString().slice(0, 10);
        if (!threadsByDay.has(lastDay))
            threadsByDay.set(lastDay, []);
        threadsByDay.get(lastDay).push(t);
    }
    // Include ALL days — bursts, events, AND threads (chat-only days must appear too)
    const allDays = new Set([...burstsByDay.keys(), ...eventsByDay.keys(), ...threadsByDay.keys()]);
    const dayStats = [];
    for (const date of allDays) {
        const dayBursts = (_a = burstsByDay.get(date)) !== null && _a !== void 0 ? _a : [];
        const dayEvents = (_b = eventsByDay.get(date)) !== null && _b !== void 0 ? _b : [];
        const dayThreads = (_c = threadsByDay.get(date)) !== null && _c !== void 0 ? _c : [];
        const uniqueFiles = new Set();
        const patterns = new Map();
        let totalAdded = 0, totalRemoved = 0;
        for (const b of dayBursts) {
            for (const f of b.files)
                uniqueFiles.add(f);
            patterns.set(b.pattern.type, ((_d = patterns.get(b.pattern.type)) !== null && _d !== void 0 ? _d : 0) + 1);
        }
        for (const e of dayEvents) {
            uniqueFiles.add(e.path);
            totalAdded += (_e = e.linesAdded) !== null && _e !== void 0 ? _e : 0;
            totalRemoved += (_f = e.linesRemoved) !== null && _f !== void 0 ? _f : 0;
        }
        const sessions = clusterBurstsIntoSessions(dayBursts, dayEvents, dayThreads);
        dayStats.push({
            date,
            sessions,
            totalBursts: dayBursts.length,
            totalSaves: dayEvents.length,
            totalAdded,
            totalRemoved,
            uniqueFiles,
            patterns,
            threads: dayThreads,
        });
    }
    return dayStats.sort((a, b) => a.date.localeCompare(b.date));
}
// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function shortPath(p) {
    // Show just filename for common paths
    const parts = p.split("/");
    return parts.length > 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : p;
}
function topFiles(files, events, limit = 5) {
    var _a;
    const counts = new Map();
    for (const e of events) {
        if (files.has(e.path)) {
            counts.set(e.path, ((_a = counts.get(e.path)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([p, c]) => `${shortPath(p)} (${c})`);
}
function formatPatterns(patterns) {
    return [...patterns.entries()]
        .filter(([t]) => t !== "unknown")
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t} ×${c}`)
        .join(", ") || "mixed";
}
function formatTime(iso) {
    return iso.slice(11, 16); // HH:MM
}
function cleanThreadTitle(title) {
    // Remove XML tags, truncate
    return title.replace(/<[^>]+>/g, "").trim().slice(0, 50) || "(untitled)";
}
const VALID_PROVIDERS_SET = new Set(["cursor", "claude_code", "vscode", "copilot", "chatgpt", "gemini", "perplexity", "unknown"]);
function cleanProvider(provider) {
    let prov = (provider !== null && provider !== void 0 ? provider : "").replace(/:.*/, "").trim().toLowerCase();
    return VALID_PROVIDERS_SET.has(prov) ? prov : "";
}
function formatThread(t) {
    const prov = cleanProvider(t.provider);
    return `"${cleanThreadTitle(t.title)}" (${t.count} msgs${prov ? `, ${prov}` : ""})`;
}
// ---------------------------------------------------------------------------
// TIMELINE.MD GENERATOR
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Timeline rendering helpers
// ---------------------------------------------------------------------------
function humanDate(iso) {
    const d = new Date(iso + "T12:00:00Z");
    const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
    const month = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"][d.getUTCMonth()];
    return `${weekday}, ${month} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
function shortDate(iso) {
    const d = new Date(iso + "T12:00:00Z");
    const weekday = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getUTCDay()];
    return `${weekday} ${iso}`;
}
function describeDuration(startIso, endIso) {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 2)
        return "brief";
    if (mins < 60)
        return `${mins}min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h${m.toString().padStart(2, "0")}` : `${h}h`;
}
function timeOfDay(iso) {
    const h = parseInt(iso.slice(11, 13), 10);
    if (h < 6)
        return "Night";
    if (h < 12)
        return "Morning";
    if (h < 18)
        return "Afternoon";
    return "Evening";
}
function patternTags(patterns) {
    const sorted = [...patterns.entries()].filter(([t]) => t !== "unknown").sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0)
        return "";
    return sorted.map(([t]) => t).join(" + ");
}
/** Pad or truncate a string to exact width */
function pad(s, w) {
    if (s.length >= w)
        return s.slice(0, w);
    return s + " ".repeat(w - s.length);
}
/** Right-align a string to exact width */
function rpad(s, w) {
    if (s.length >= w)
        return s.slice(0, w);
    return " ".repeat(w - s.length) + s;
}
/** Create a dot-leader line: "title ········· value" */
function dotLeader(left, right, width = 68) {
    const dotsNeeded = width - left.length - right.length - 2;
    if (dotsNeeded < 3)
        return `${left}  ${right}`;
    return `${left} ${"·".repeat(dotsNeeded)} ${right}`;
}
/** Deduplicate threads by thread_key, summing counts */
function dedupeThreads(threads) {
    const seen = new Map();
    for (const t of threads) {
        const existing = seen.get(t.thread_key);
        if (existing) {
            // Keep highest count (same thread across sessions)
            if (t.count > existing.count)
                seen.set(t.thread_key, t);
        }
        else {
            seen.set(t.thread_key, t);
        }
    }
    return [...seen.values()];
}
/** Clean topic names: remove long paths, keep short meaningful names */
function cleanTopic(topic) {
    // Extract just the filename from full paths
    if (topic.includes("/")) {
        const parts = topic.split("/");
        const file = parts[parts.length - 1];
        if (file && file.length > 0 && file.length < 40)
            return file;
        return parts.slice(-2).join("/");
    }
    return topic.length > 30 ? topic.slice(0, 27) + "..." : topic;
}
// ---------------------------------------------------------------------------
// TIMELINE.MD GENERATOR — Narrative Journal
// ---------------------------------------------------------------------------
const W = 72; // box width (inner content)
export function rebuildTimeline(root) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const evDir = resolveUnderRoot(root, ".rl4", "evidence");
    const bursts = readJsonl(path.join(evDir, "sessions.jsonl"), "burst_id");
    const events = readJsonl(path.join(evDir, "activity.jsonl"), "t");
    const threads = readJsonl(path.join(evDir, "chat_threads.jsonl"), "thread_key");
    const days = groupByDay(bursts, events, threads);
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const totalMsgsAll = threads.reduce((sum, t) => sum + t.count, 0);
    const totalLines = events.reduce((sum, e) => { var _a, _b; return sum + ((_a = e.linesAdded) !== null && _a !== void 0 ? _a : 0) + ((_b = e.linesRemoved) !== null && _b !== void 0 ? _b : 0); }, 0);
    const L = [];
    // ══════════════════════════════════════════════════════════════════════
    // HEADER
    // ══════════════════════════════════════════════════════════════════════
    L.push("```");
    L.push("╔══════════════════════════════════════════════════════════════════════════════╗");
    L.push("║                                                                              ║");
    L.push("║     ████████╗██╗███╗   ███╗███████╗██╗     ██╗███╗   ██╗███████╗             ║");
    L.push("║     ╚══██╔══╝██║████╗ ████║██╔════╝██║     ██║████╗  ██║██╔════╝             ║");
    L.push("║        ██║   ██║██╔████╔██║█████╗  ██║     ██║██╔██╗ ██║█████╗               ║");
    L.push("║        ██║   ██║██║╚██╔╝██║██╔══╝  ██║     ██║██║╚██╗██║██╔══╝               ║");
    L.push("║        ██║   ██║██║ ╚═╝ ██║███████╗███████╗██║██║ ╚████║███████╗             ║");
    L.push("║        ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝╚══════╝             ║");
    L.push("║                                                                              ║");
    L.push("║                      DEVELOPER'S JOURNAL                                     ║");
    L.push("║                                                                              ║");
    L.push("╠══════════════════════════════════════════════════════════════════════════════╣");
    L.push(`║  ${pad(`${days.length} active days  ·  ${events.length.toLocaleString()} file events  ·  ${totalMsgsAll.toLocaleString()} messages`, 76)} ║`);
    L.push(`║  ${pad(`${totalLines.toLocaleString()} lines changed  ·  ${threads.length} conversations  ·  ${bursts.length} bursts`, 76)} ║`);
    L.push(`║  ${pad(`Coverage: ${(_b = (_a = days[0]) === null || _a === void 0 ? void 0 : _a.date) !== null && _b !== void 0 ? _b : "—"} to ${(_d = (_c = days[days.length - 1]) === null || _c === void 0 ? void 0 : _c.date) !== null && _d !== void 0 ? _d : "—"}`, 76)} ║`);
    L.push("║                                                                              ║");
    L.push(`║  ${pad(`Last rebuilt: ${now}`, 76)} ║`);
    L.push(`║  ${pad("Forensic drill-down: get_timeline(date_from, date_to)", 76)} ║`);
    L.push("║  Auto-generated from JSONL evidence · Mechanically truthful                  ║");
    L.push("╚══════════════════════════════════════════════════════════════════════════════╝");
    L.push("```");
    L.push("");
    L.push("");
    // ══════════════════════════════════════════════════════════════════════
    // PER-DAY ENTRIES
    // ══════════════════════════════════════════════════════════════════════
    for (let i = 0; i < days.length; i++) {
        const day = days[i];
        const totalMsgs = day.threads.reduce((sum, t) => sum + t.count, 0);
        const allThreads = dedupeThreads(day.sessions.flatMap(s => s.threads).concat(day.threads));
        const uniqueThreads = dedupeThreads(allThreads).sort((a, b) => b.count - a.count);
        // ── Day header box ──
        const dateStr = humanDate(day.date);
        const tagStr = day.sessions.length > 0 ? patternTags(day.patterns) : (day.threads.length > 0 ? "conversations" : "file activity");
        L.push("```");
        L.push(`┌${"─".repeat(W)}┐`);
        L.push(`│  ${pad(dateStr.toUpperCase(), W - 4)}  │`);
        L.push(`│  ${pad("─".repeat(dateStr.length), W - 4)}  │`);
        if (day.sessions.length > 0) {
            const net = day.totalAdded - day.totalRemoved;
            const netSign = net >= 0 ? "+" : "";
            L.push(`│  ${pad(`${day.sessions.length} session${day.sessions.length > 1 ? "s" : ""}  ·  ${day.totalSaves} saves  ·  ${day.uniqueFiles.size} files  ·  ${netSign}${net.toLocaleString()} net lines`, W - 4)}  │`);
            if (tagStr)
                L.push(`│  ${pad(tagStr, W - 4)}  │`);
        }
        else if (day.threads.length > 0) {
            L.push(`│  ${pad(`${uniqueThreads.length} conversation${uniqueThreads.length > 1 ? "s" : ""}  ·  ${totalMsgs} messages`, W - 4)}  │`);
        }
        else {
            L.push(`│  ${pad(`${day.totalSaves} saves  ·  ${day.uniqueFiles.size} files`, W - 4)}  │`);
        }
        L.push(`└${"─".repeat(W)}┘`);
        L.push("```");
        L.push("");
        // ── Sessions ──
        if (day.sessions.length > 0) {
            const dayEvents = events.filter(e => e.t.startsWith(day.date));
            for (const session of day.sessions) {
                const start = formatTime(session.start);
                const end = formatTime(session.end);
                const tod = timeOfDay(session.start);
                const dur = describeDuration(session.start, session.end);
                // WHY line: [TAG] + dominant thread title = the story of this session
                const sessionTag = [...session.patterns.entries()]
                    .filter(([t]) => t !== "unknown")
                    .sort((a, b) => b[1] - a[1])
                    .map(([t]) => t.toUpperCase())
                    .slice(0, 2)
                    .join(" + ");
                const dominantThread = session.threads.length > 0
                    ? session.threads.sort((a, b) => b.count - a.count)[0]
                    : null;
                const threadContext = dominantThread
                    ? ` — "${cleanThreadTitle(dominantThread.title)}"`
                    : "";
                // Session heading with WHY
                if (sessionTag) {
                    L.push(`**[${sessionTag}]** ${start} – ${end} · ${tod} · ${dur}${threadContext}`);
                }
                else {
                    L.push(`**${start} – ${end}** · ${tod} · ${dur}${threadContext}`);
                }
                L.push("");
                // Files — clean, compact
                const hot = topFiles(session.files, dayEvents, 4);
                if (hot.length > 0) {
                    L.push(`    Files: ${hot.join("  ·  ")}`);
                }
                else if (session.files.size > 0) {
                    L.push(`    Files: ${[...session.files].slice(0, 4).map(shortPath).join("  ·  ")}`);
                }
                // Lines
                if (session.linesAdded > 0 || session.linesRemoved > 0) {
                    L.push(`    Lines: +${session.linesAdded.toLocaleString()} / -${session.linesRemoved.toLocaleString()}`);
                }
                L.push("");
            }
        }
        // ── Conversations (deduplicated at day level) ──
        if (uniqueThreads.length > 0) {
            const topThreads = uniqueThreads.slice(0, 5);
            for (const t of topThreads) {
                const prov = cleanProvider(t.provider);
                const title = cleanThreadTitle(t.title).slice(0, 55);
                const right = `${t.count} msgs${prov ? ` · ${prov}` : ""}`;
                L.push(dotLeader(`    "${title}"`, right));
            }
            if (uniqueThreads.length > 5) {
                L.push(`    ... and ${uniqueThreads.length - 5} more`);
            }
            L.push("");
        }
        // ── Topics ──
        const dayTopics = allThreads.flatMap(t => { var _a; return (_a = t.topics) !== null && _a !== void 0 ? _a : []; }).filter(Boolean);
        if (dayTopics.length > 0) {
            const unique = [...new Set(dayTopics)].slice(0, 6).map(cleanTopic);
            L.push(`    tags: ${unique.join("  ·  ")}`);
            L.push("");
        }
        // ── Silence gap ──
        if (i < days.length - 1) {
            const nextDate = days[i + 1].date;
            const gapDays = Math.round((new Date(nextDate).getTime() - new Date(day.date).getTime()) / 86400000);
            if (gapDays > 1) {
                const gapLabel = `${gapDays - 1} day${gapDays - 1 > 1 ? "s" : ""} of silence`;
                const totalDots = W - gapLabel.length - 2;
                const leftDots = Math.floor(totalDots / 2);
                const rightDots = totalDots - leftDots;
                L.push(`${"·".repeat(leftDots)} ${gapLabel} ${"·".repeat(rightDots)}`);
                L.push("");
            }
        }
    }
    // ══════════════════════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════════════════════
    L.push("```");
    L.push(`╔${"═".repeat(W)}╗`);
    L.push(`║  ${pad("End of journal", W - 4)}  ║`);
    L.push(`║  ${pad(`${days.length} days recorded · ${(_f = (_e = days[0]) === null || _e === void 0 ? void 0 : _e.date) !== null && _f !== void 0 ? _f : "—"} to ${(_h = (_g = days[days.length - 1]) === null || _g === void 0 ? void 0 : _g.date) !== null && _h !== void 0 ? _h : "—"}`, W - 4)}  ║`);
    L.push(`╚${"═".repeat(W)}╝`);
    L.push("```");
    L.push("");
    return L.join("\n");
}
// ---------------------------------------------------------------------------
// EVIDENCE.MD GENERATOR
// ---------------------------------------------------------------------------
export function rebuildEvidence(root) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    const evDir = resolveUnderRoot(root, ".rl4", "evidence");
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    const bursts = readJsonl(path.join(evDir, "sessions.jsonl"), "burst_id");
    const events = readJsonl(path.join(evDir, "activity.jsonl"), "t");
    const threads = readJsonl(path.join(evDir, "chat_threads.jsonl"), "thread_key");
    const msgCount = countLines(path.join(evDir, "chat_history.jsonl"));
    // File index for blob count
    let blobCount = 0;
    const fileIndexPath = path.join(rl4Dir, "snapshots", "file_index.json");
    if (fs.existsSync(fileIndexPath)) {
        try {
            const idx = JSON.parse(fs.readFileSync(fileIndexPath, "utf8"));
            blobCount = Object.keys(idx).length;
        }
        catch { /* skip */ }
    }
    let intentGraph = { chains: [], couplings: [], summary: { total_files_tracked: 0, files_with_reversals: 0 } };
    const igPath = path.join(rl4Dir, "intent_graph.json");
    if (fs.existsSync(igPath)) {
        try {
            intentGraph = JSON.parse(fs.readFileSync(igPath, "utf8"));
        }
        catch { /* skip */ }
    }
    // Causal links count for proof coverage
    const causalLinksPath = path.join(rl4Dir, ".internal", "causal_links.jsonl");
    const causalLinkCount = countLines(causalLinksPath);
    // --- Compute stats ---
    const MIN_VALID_MS = new Date("2020-01-01").getTime();
    const allDays = new Set();
    for (const b of bursts)
        allDays.add(b.t.slice(0, 10));
    for (const e of events)
        allDays.add(e.t.slice(0, 10));
    for (const t of threads) {
        if (t.lastMs && t.lastMs >= MIN_VALID_MS)
            allDays.add(new Date(t.lastMs).toISOString().slice(0, 10));
        if (t.firstMs && t.firstMs >= MIN_VALID_MS)
            allDays.add(new Date(t.firstMs).toISOString().slice(0, 10));
    }
    const sortedDays = [...allDays].sort();
    const firstDay = (_a = sortedDays[0]) !== null && _a !== void 0 ? _a : "—";
    const lastDay = (_b = sortedDays[sortedDays.length - 1]) !== null && _b !== void 0 ? _b : "—";
    const totalDays = sortedDays.length;
    // Calendar span (including gaps)
    let calendarSpan = 0;
    if (sortedDays.length >= 2) {
        calendarSpan = Math.round((new Date(lastDay).getTime() - new Date(firstDay).getTime()) / 86400000) + 1;
    }
    else if (sortedDays.length === 1) {
        calendarSpan = 1;
    }
    // Streak
    let currentStreak = 0, bestStreak = 0;
    if (sortedDays.length > 0) {
        currentStreak = 1;
        for (let i = sortedDays.length - 1; i > 0; i--) {
            const diff = (new Date(sortedDays[i]).getTime() - new Date(sortedDays[i - 1]).getTime()) / 86400000;
            if (diff <= 1)
                currentStreak++;
            else
                break;
        }
        bestStreak = 1;
        let streak = 1;
        for (let i = 1; i < sortedDays.length; i++) {
            const diff = (new Date(sortedDays[i]).getTime() - new Date(sortedDays[i - 1]).getTime()) / 86400000;
            if (diff <= 1) {
                streak++;
                bestStreak = Math.max(bestStreak, streak);
            }
            else {
                streak = 1;
            }
        }
    }
    // Lines
    let totalAdded = 0, totalRemoved = 0;
    for (const e of events) {
        totalAdded += (_c = e.linesAdded) !== null && _c !== void 0 ? _c : 0;
        totalRemoved += (_d = e.linesRemoved) !== null && _d !== void 0 ? _d : 0;
    }
    // Unique files
    const allFiles = new Set();
    for (const e of events)
        allFiles.add(e.path);
    // Tech stack
    const extCounts = new Map();
    for (const f of allFiles) {
        const ext = path.extname(f).replace(".", "").toLowerCase();
        if (ext)
            extCounts.set(ext, ((_e = extCounts.get(ext)) !== null && _e !== void 0 ? _e : 0) + 1);
    }
    const topExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const totalExtFiles = [...extCounts.values()].reduce((a, b) => a + b, 0) || 1;
    // Ext name map for pretty names
    const EXT_NAMES = {
        js: "JavaScript", ts: "TypeScript", md: "Markdown", mdc: "MDC Rules",
        json: "JSON", css: "CSS", html: "HTML", py: "Python", sql: "SQL",
        sh: "Shell", yml: "YAML", yaml: "YAML", tsx: "TSX", jsx: "JSX",
        png: "PNG", svg: "SVG", go: "Go", rs: "Rust", rb: "Ruby",
    };
    // Pattern summary
    const patternCounts = new Map();
    for (const b of bursts)
        patternCounts.set(b.pattern.type, ((_f = patternCounts.get(b.pattern.type)) !== null && _f !== void 0 ? _f : 0) + 1);
    const topPatterns = [...patternCounts.entries()]
        .filter(([t]) => t !== "unknown")
        .sort((a, b) => b[1] - a[1]).slice(0, 6);
    // Peak hours
    const hourCounts = new Map();
    for (const e of events) {
        const h = parseInt(e.t.slice(11, 13));
        hourCounts.set(h, ((_g = hourCounts.get(h)) !== null && _g !== void 0 ? _g : 0) + 1);
    }
    const peakHours = [...hourCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => `${h}h`).join("  ");
    // Provider stats — tool-level (Claude Code, Cursor) AND model-level
    // Only accept clean provider strings: word chars, colons, hyphens, dots
    const PROVIDER_RE = /^[a-zA-Z0-9_:.\-]+$/;
    const VALID_TOOLS = new Set(["claude_code", "cursor", "vscode", "copilot", "chatgpt", "gemini", "perplexity"]);
    const toolCounts = new Map();
    const modelCounts = new Map();
    for (const t of threads) {
        const raw = ((_h = t.provider) !== null && _h !== void 0 ? _h : "").trim();
        if (!raw || !PROVIDER_RE.test(raw))
            continue; // skip dirty/malformed providers
        // Tool level
        const toolName = raw.replace(/:.*/, "").toLowerCase();
        if (!VALID_TOOLS.has(toolName))
            continue;
        const cleanTool = toolName === "claude_code" ? "Claude Code" : toolName === "cursor" ? "Cursor" : toolName;
        toolCounts.set(cleanTool, ((_j = toolCounts.get(cleanTool)) !== null && _j !== void 0 ? _j : 0) + t.count);
        // Model level — extract after first colon, skip synthetic markers
        const modelMatch = raw.match(/^[^:]+:([a-zA-Z0-9._-]+)/);
        if (modelMatch) {
            let model = modelMatch[1].replace(/^claude-/, "").replace(/-\d{8,}$/, "").trim();
            if (model && model !== "undefined" && !model.startsWith("<")) {
                modelCounts.set(model, ((_k = modelCounts.get(model)) !== null && _k !== void 0 ? _k : 0) + t.count);
            }
        }
    }
    // AI Traceability
    const chains = (_l = intentGraph.chains) !== null && _l !== void 0 ? _l : [];
    const totalTracked = chains.length;
    const filesWithProof = chains.filter(c => c.versions > 0).length;
    const totalReversals = chains.reduce((s, c) => { var _a; return s + ((_a = c.reversals) !== null && _a !== void 0 ? _a : 0); }, 0);
    const totalVersions = chains.reduce((s, c) => { var _a; return s + ((_a = c.versions) !== null && _a !== void 0 ? _a : 0); }, 0);
    const reversalRate = totalVersions > 0 ? Math.round((totalReversals / totalVersions) * 100) : 0;
    // Couplings
    const couplings = ((_m = intentGraph.couplings) !== null && _m !== void 0 ? _m : []).sort((a, b) => b.co_modifications - a.co_modifications).slice(0, 5);
    // Hot files with trajectories (from intent_graph, fallback to save frequency)
    const chainsByFile = new Map();
    for (const c of chains)
        chainsByFile.set(c.file, c);
    const fileSaveCounts = new Map();
    for (const e of events) {
        if (/\/(dist|node_modules|\.next|\.rl4)\//.test(e.path) || e.path.startsWith("dist/"))
            continue;
        fileSaveCounts.set(e.path, ((_o = fileSaveCounts.get(e.path)) !== null && _o !== void 0 ? _o : 0) + 1);
    }
    // Merge: prefer intent_graph chains (have score/trajectory), augment with save counts
    const hotFileEntries = [];
    const seenFiles = new Set();
    // First: files from intent_graph sorted by hot_score
    for (const c of [...chains].sort((a, b) => b.hot_score - a.hot_score)) {
        const saves = (_p = fileSaveCounts.get(c.file)) !== null && _p !== void 0 ? _p : 0;
        hotFileEntries.push({ file: c.file, saves, score: c.hot_score, trajectory: c.trajectory, reversals: (_q = c.reversals) !== null && _q !== void 0 ? _q : 0 });
        seenFiles.add(c.file);
    }
    // Then: high-save files not in intent_graph
    for (const [f, saves] of [...fileSaveCounts.entries()].sort((a, b) => b[1] - a[1])) {
        if (seenFiles.has(f))
            continue;
        hotFileEntries.push({ file: f, saves, score: 0, trajectory: "linear", reversals: 0 });
        seenFiles.add(f);
        if (hotFileEntries.length >= 10)
            break;
    }
    const topHotFiles = hotFileEntries.sort((a, b) => b.score - a.score || b.saves - a.saves).slice(0, 10);
    // Trajectory summary
    const trajCounts = new Map();
    for (const c of chains)
        trajCounts.set(c.trajectory, ((_r = trajCounts.get(c.trajectory)) !== null && _r !== void 0 ? _r : 0) + 1);
    // ─── ASCII box helpers ───
    const W = 78; // outer box width
    const IW = W - 4; // inner content width (│  ...  │)
    function boxTop(title) {
        const fill = W - 5 - title.length; // ┌─ TITLE ─...─┐
        return `┌─ ${title} ${"─".repeat(Math.max(1, fill))}┐`;
    }
    function boxBot() { return `└${"─".repeat(W - 2)}┘`; }
    function boxEmpty() { return `│${" ".repeat(W - 2)}│`; }
    function boxLine(content) {
        const padded = `  ${content}`;
        const fill = W - 2 - padded.length;
        return fill >= 0 ? `│${padded}${" ".repeat(fill)}│` : `│${padded.slice(0, W - 2)}│`;
    }
    function progressBar(pct, len) {
        const filled = Math.round((pct / 100) * len);
        return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, len - filled));
    }
    function fmtNum(n) {
        return n.toLocaleString("en-US").replace(/,/g, " ");
    }
    // ─── Build output ───
    const wsName = path.basename(path.resolve(root));
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    const userName = process.env.USER || process.env.USERNAME || "dev";
    const L = [];
    L.push("```");
    // ═══ Header ═══
    L.push("╔" + "═".repeat(W - 2) + "╗");
    L.push(`║  RL4 EVIDENCE DASHBOARD${" ".repeat(13)}${wsName.padEnd(18)}${userName.padStart(13)}  ║`);
    L.push(`║  Auto-generated ${now}${" ".repeat(18)}Narratives -> timeline.md  ║`);
    L.push("╚" + "═".repeat(W - 2) + "╝");
    L.push("");
    // ─── PROJECT PULSE ───
    L.push(boxTop("PROJECT PULSE"));
    L.push(boxEmpty());
    L.push(boxLine(`Period   ${firstDay} ${"─".repeat(20)} ${lastDay}`));
    const activePct = calendarSpan > 0 ? Math.round((totalDays / calendarSpan) * 100) : 0;
    L.push(boxLine(`Active   ${progressBar(activePct, 32)}  ${totalDays}/${calendarSpan} days (${activePct}%)`));
    const streakPct = bestStreak > 0 ? Math.round((currentStreak / Math.max(bestStreak, 14)) * 100) : 0;
    L.push(boxLine(`Streak   ${progressBar(streakPct, 12)}  current ${currentStreak}d | best ${bestStreak}d`));
    L.push(boxEmpty());
    // Cluster sessions from bursts
    const sessionCount = groupByDay(bursts, events, threads).reduce((s, d) => s + d.sessions.length, 0);
    L.push(boxLine(`${sessionCount} sessions    ${threads.length} conversations    ${fmtNum(msgCount)} messages    ${allFiles.size} files`));
    L.push(boxEmpty());
    L.push(boxBot());
    L.push("");
    // ─── CODE ───
    L.push(boxTop("CODE"));
    L.push(boxEmpty());
    const maxLines = Math.max(totalAdded, totalRemoved, 1);
    const addBar = progressBar(Math.round((totalAdded / maxLines) * 100), 20);
    const remBar = progressBar(Math.round((totalRemoved / maxLines) * 100), 20);
    const net = totalAdded - totalRemoved;
    L.push(boxLine(`+ ${fmtNum(totalAdded).padStart(9)}  ${addBar} lines added`));
    L.push(boxLine(`- ${fmtNum(totalRemoved).padStart(9)}  ${remBar} lines removed`));
    L.push(boxLine(`${"─".repeat(34)} net ${net >= 0 ? "+" : ""}${fmtNum(net)}`));
    L.push(boxEmpty());
    if (peakHours)
        L.push(boxLine(`Peak hours: ${peakHours}`));
    L.push(boxBot());
    L.push("");
    // ─── TECH STACK ───
    L.push(boxTop("TECH STACK"));
    L.push(boxEmpty());
    for (const [ext, count] of topExts) {
        const pct = Math.round((count / totalExtFiles) * 100);
        const name = ((_s = EXT_NAMES[ext]) !== null && _s !== void 0 ? _s : ext).padEnd(12);
        const bar = progressBar(pct, 20);
        L.push(boxLine(`${name} ${bar}  ${String(pct).padStart(3)}%  (${count} files)`));
    }
    L.push(boxEmpty());
    L.push(boxBot());
    L.push("");
    // ─── AI TRACEABILITY ───
    L.push(boxTop("AI TRACEABILITY"));
    L.push(boxEmpty());
    const proofPct = totalTracked > 0 ? Math.round((filesWithProof / totalTracked) * 100) : 0;
    L.push(boxLine(`Proof Coverage  ${progressBar(proofPct, 20)}  ${proofPct}%   ${causalLinkCount} chains / ${totalTracked} files`));
    const revTrust = reversalRate === 0 ? "high AI trust" : reversalRate < 10 ? "good" : "needs review";
    L.push(boxLine(`Reversal Rate   ${progressBar(reversalRate, 20)}  ${reversalRate}%   ${revTrust}`));
    // Tool breakdown
    const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sortedTools.length > 0) {
        const maxToolCount = sortedTools[0][1];
        const toolParts = sortedTools.map(([name, count]) => {
            const bar = progressBar(Math.round((count / maxToolCount) * 100), 10);
            return `${name} ${bar}`;
        });
        L.push(boxLine(`Tools           ${toolParts.join("  ")}`));
        // Model breakdown
        const sortedModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        if (sortedModels.length > 0) {
            const maxModelCount = sortedModels[0][1];
            const modelParts = sortedModels.map(([name, count]) => {
                const bar = progressBar(Math.round((count / maxModelCount) * 100), 4);
                return `${name} ${bar}`;
            });
            L.push(boxLine(`                └─ ${modelParts.join("  ")}`));
        }
    }
    L.push(boxEmpty());
    L.push(boxBot());
    L.push("");
    // ─── WORK PATTERNS ───
    if (topPatterns.length > 0) {
        L.push(boxTop("WORK PATTERNS"));
        L.push(boxEmpty());
        // Grid layout: 3 per row
        const maxPatCount = topPatterns[0][1];
        for (let i = 0; i < topPatterns.length; i += 3) {
            const row = topPatterns.slice(i, i + 3);
            const parts = row.map(([pat, count]) => {
                const bar = progressBar(Math.round((count / maxPatCount) * 100), 8);
                return `${pat.padEnd(10)} ${bar} ${String(count).padStart(3)}`;
            });
            L.push(boxLine(parts.join("    ")));
        }
        L.push(boxEmpty());
        L.push(boxBot());
        L.push("");
    }
    // ─── HOT FILES & TRAJECTORIES ───
    L.push(boxTop("HOT FILES & TRAJECTORIES"));
    L.push(boxEmpty());
    L.push(boxLine("#   File                      Saves  Score  Trajectory   Reversals"));
    L.push(boxLine("─── ───────────────────────── ───── ────── ──────────── ──────────"));
    for (let i = 0; i < topHotFiles.length; i++) {
        const h = topHotFiles[i];
        const fname = shortPath(h.file).slice(0, 25).padEnd(25);
        const saves = String(h.saves).padStart(5);
        const score = h.score.toFixed(2).padStart(6);
        const traj = h.trajectory.padEnd(12);
        const revs = String(h.reversals).padStart(5);
        L.push(boxLine(`${String(i + 1).padStart(2)}  ${fname} ${saves} ${score} ${traj} ${revs}`));
    }
    L.push(boxEmpty());
    // Trajectory summary
    const trajParts = [...trajCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`);
    if (trajParts.length > 0) {
        L.push(boxLine(`Trajectories:  ${trajParts.join(" ─── ")}`));
        L.push(boxEmpty());
    }
    L.push(boxBot());
    L.push("");
    // ─── FILE COUPLINGS ───
    if (couplings.length > 0) {
        L.push(boxTop("FILE COUPLINGS"));
        L.push(boxEmpty());
        for (const c of couplings) {
            const f1 = shortPath(c.files[0]).padEnd(24);
            const f2 = shortPath(c.files[1]).padEnd(24);
            L.push(boxLine(`${f1} ${"═".repeat(12)} ${f2} ${c.co_modifications} co-mods`));
        }
        L.push(boxEmpty());
        L.push(boxBot());
        L.push("");
    }
    // ─── Footer ───
    L.push("─".repeat(W));
    L.push(` RL4 Evidence • Proof-based • Zero NLP • Mechanical facts only`);
    L.push("─".repeat(W));
    L.push("```");
    return L.join("\n");
}
/**
 * Query JSONL evidence for a specific date range and return rich, forensic detail.
 * This is the "live MCP query" counterpart to the static timeline.md index.
 *
 * Returns structured markdown with:
 * - Per-day breakdown with sessions, files, line counts
 * - Actual chat message summaries (first 200 chars of each assistant message)
 * - Thread titles with message counts
 * - File change details
 */
export function queryDateRange(root, dateFrom, dateTo) {
    var _a, _b, _c;
    const evDir = resolveUnderRoot(root, ".rl4", "evidence");
    const bursts = readJsonl(path.join(evDir, "sessions.jsonl"), "burst_id");
    const events = readJsonl(path.join(evDir, "activity.jsonl"), "t");
    const threads = readJsonl(path.join(evDir, "chat_threads.jsonl"), "thread_key");
    // Load chat messages for the date range (filtered by timestamp)
    const fromMs = new Date(dateFrom + "T00:00:00Z").getTime();
    const toMs = new Date(dateTo + "T23:59:59Z").getTime();
    const chatPath = path.join(evDir, "chat_history.jsonl");
    const messages = [];
    if (fs.existsSync(chatPath)) {
        const content = fs.readFileSync(chatPath, "utf8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{"))
                continue;
            try {
                const msg = JSON.parse(trimmed);
                if (msg.unix_ms && msg.unix_ms >= fromMs && msg.unix_ms <= toMs) {
                    messages.push(msg);
                }
            }
            catch { /* skip */ }
        }
    }
    // Group messages by thread AND by day
    const msgByThread = new Map();
    const msgByDay = new Map();
    for (const m of messages) {
        if (!msgByThread.has(m.thread_id))
            msgByThread.set(m.thread_id, []);
        msgByThread.get(m.thread_id).push(m);
        const day = new Date(m.unix_ms).toISOString().slice(0, 10);
        if (!msgByDay.has(day))
            msgByDay.set(day, []);
        msgByDay.get(day).push(m);
    }
    // Group everything by day
    const days = groupByDay(bursts, events, threads);
    const filteredDays = days.filter(d => d.date >= dateFrom && d.date <= dateTo);
    // Also include days that have messages but no bursts/events/threads
    const allDateRange = new Set();
    for (const d of filteredDays)
        allDateRange.add(d.date);
    for (const day of msgByDay.keys()) {
        if (day >= dateFrom && day <= dateTo)
            allDateRange.add(day);
    }
    if (filteredDays.length === 0 && msgByDay.size === 0) {
        return `No activity found between ${dateFrom} and ${dateTo}.`;
    }
    const lines = [];
    lines.push(`# Activity: ${dateFrom} → ${dateTo}`);
    lines.push("");
    for (const day of filteredDays) {
        lines.push(`## ${day.date}`);
        lines.push("");
        // Summary line
        if (day.totalSaves > 0) {
            const net = day.totalAdded - day.totalRemoved;
            lines.push(`**${day.totalSaves} saves** | +${day.totalAdded.toLocaleString()}/-${day.totalRemoved.toLocaleString()} (net ${net >= 0 ? "+" : ""}${net.toLocaleString()}) | ${day.uniqueFiles.size} files | ${day.sessions.length} sessions`);
            lines.push("");
        }
        // Sessions with detail
        if (day.sessions.length > 0) {
            for (const session of day.sessions) {
                const startTime = formatTime(session.start);
                const endTime = formatTime(session.end);
                const dominant = formatPatterns(session.patterns);
                lines.push(`### ${startTime}–${endTime} | ${dominant} (${session.bursts.length} bursts)`);
                // Files changed in this session
                if (session.files.size > 0) {
                    const dayEvents = events.filter(e => e.t.startsWith(day.date));
                    const hot = topFiles(session.files, dayEvents, 6);
                    lines.push(`- **Files**: ${hot.length > 0 ? hot.join(", ") : [...session.files].slice(0, 6).map(shortPath).join(", ")}`);
                }
                if (session.linesAdded > 0 || session.linesRemoved > 0) {
                    lines.push(`- **Lines**: +${session.linesAdded.toLocaleString()} / -${session.linesRemoved.toLocaleString()}`);
                }
                // Chat threads active during this session — with actual content
                if (session.threads.length > 0) {
                    lines.push(`- **Conversations** (${session.threads.length}):`);
                    for (const t of session.threads.sort((a, b) => b.count - a.count).slice(0, 5)) {
                        const prov = cleanProvider(t.provider);
                        lines.push(`  - "${cleanThreadTitle(t.title)}" — ${t.count} msgs${prov ? ` (${prov})` : ""}`);
                        // Show key assistant messages from this thread
                        const threadMsgs = (_a = msgByThread.get(t.thread_key)) !== null && _a !== void 0 ? _a : [];
                        const assistantMsgs = threadMsgs
                            .filter(m => m.role === "assistant" && m.content.length > 50)
                            .sort((a, b) => b.content.length - a.content.length)
                            .slice(0, 2);
                        for (const am of assistantMsgs) {
                            const snippet = am.content
                                .replace(/```[\s\S]*?```/g, "[code]")
                                .replace(/<[^>]+>/g, "")
                                .replace(/\n+/g, " ")
                                .trim()
                                .slice(0, 200);
                            if (snippet.length > 30) {
                                lines.push(`    > ${snippet}${am.content.length > 200 ? "…" : ""}`);
                            }
                        }
                    }
                }
                lines.push("");
            }
        }
        // Chat-only day (no file events)
        if (day.sessions.length === 0 && day.threads.length > 0) {
            const totalMsgs = day.threads.reduce((sum, t) => sum + t.count, 0);
            lines.push(`**Conversations only** — ${day.threads.length} threads, ${totalMsgs} messages`);
            lines.push("");
            for (const t of day.threads.sort((a, b) => b.count - a.count).slice(0, 6)) {
                const prov = cleanProvider(t.provider);
                lines.push(`### "${cleanThreadTitle(t.title)}" — ${t.count} msgs${prov ? ` (${prov})` : ""}`);
                // Show key messages from this thread
                const threadMsgs = (_b = msgByThread.get(t.thread_key)) !== null && _b !== void 0 ? _b : [];
                const userMsgs = threadMsgs.filter(m => m.role === "user" && m.content.length > 20).slice(0, 2);
                const assistantMsgs = threadMsgs
                    .filter(m => m.role === "assistant" && m.content.length > 80)
                    .sort((a, b) => b.content.length - a.content.length)
                    .slice(0, 2);
                if (userMsgs.length > 0) {
                    const userSnippet = userMsgs[0].content.replace(/\n+/g, " ").trim().slice(0, 150);
                    lines.push(`- **User asked**: "${userSnippet}${userMsgs[0].content.length > 150 ? "…" : ""}"`);
                }
                for (const am of assistantMsgs) {
                    const snippet = am.content
                        .replace(/```[\s\S]*?```/g, "[code]")
                        .replace(/<[^>]+>/g, "")
                        .replace(/\n+/g, " ")
                        .trim()
                        .slice(0, 200);
                    if (snippet.length > 30) {
                        lines.push(`- **Assistant**: ${snippet}${am.content.length > 200 ? "…" : ""}`);
                    }
                }
                lines.push("");
            }
        }
        // Direct chat messages from chat_history.jsonl (fallback when threads don't have matches)
        const dayMsgs = (_c = msgByDay.get(day.date)) !== null && _c !== void 0 ? _c : [];
        if (dayMsgs.length > 0) {
            // Group by thread_id for display
            const threadGroups = new Map();
            for (const m of dayMsgs) {
                if (!threadGroups.has(m.thread_id))
                    threadGroups.set(m.thread_id, []);
                threadGroups.get(m.thread_id).push(m);
            }
            // Show top conversations by message count
            const sortedThreads = [...threadGroups.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, 5);
            lines.push(`**Conversations** (${threadGroups.size} threads, ${dayMsgs.length} messages):`);
            for (const [_tid, msgs] of sortedThreads) {
                const sorted = msgs.sort((a, b) => a.unix_ms - b.unix_ms);
                // Show first user message as context
                const firstUser = sorted.find(m => m.role === "user" && m.content.length > 20);
                const topAssistant = sorted
                    .filter(m => m.role === "assistant" && m.content.length > 80)
                    .sort((a, b) => b.content.length - a.content.length)[0];
                if (firstUser) {
                    const q = firstUser.content.replace(/\n+/g, " ").trim().slice(0, 120);
                    lines.push(`- **Q**: "${q}${firstUser.content.length > 120 ? "…" : ""}" (${msgs.length} msgs)`);
                }
                if (topAssistant) {
                    const a = topAssistant.content
                        .replace(/```[\s\S]*?```/g, "[code]")
                        .replace(/<[^>]+>/g, "")
                        .replace(/\n+/g, " ")
                        .trim()
                        .slice(0, 180);
                    if (a.length > 30) {
                        lines.push(`  > ${a}${topAssistant.content.length > 180 ? "…" : ""}`);
                    }
                }
            }
            lines.push("");
        }
        // Topics for the day
        const dayTopics = day.threads.flatMap(t => { var _a; return (_a = t.topics) !== null && _a !== void 0 ? _a : []; }).filter(Boolean);
        if (dayTopics.length > 0) {
            const unique = [...new Set(dayTopics)].slice(0, 8);
            lines.push(`**Topics**: ${unique.join(", ")}`);
            lines.push("");
        }
        lines.push("---");
        lines.push("");
    }
    // Cap output to prevent massive responses
    const MAX_CHARS = 12000;
    const result = lines.join("\n");
    if (result.length > MAX_CHARS) {
        return result.slice(0, MAX_CHARS) + "\n\n… (truncated — narrow the date range for more detail)";
    }
    return result;
}
// ---------------------------------------------------------------------------
// PUBLIC: rebuild both files
// ---------------------------------------------------------------------------
export function rebuildAll(root) {
    const timelineContent = rebuildTimeline(root);
    const evidenceContent = rebuildEvidence(root);
    const timelinePath = resolveUnderRoot(root, ".rl4", "timeline.md");
    const evidencePath = resolveUnderRoot(root, ".rl4", "evidence.md");
    // Ensure .rl4 dir exists
    const rl4Dir = resolveUnderRoot(root, ".rl4");
    if (!fs.existsSync(rl4Dir))
        fs.mkdirSync(rl4Dir, { recursive: true });
    fs.writeFileSync(timelinePath, timelineContent, "utf8");
    fs.writeFileSync(evidencePath, evidenceContent, "utf8");
    return { timelineChars: timelineContent.length, evidenceChars: evidenceContent.length };
}
