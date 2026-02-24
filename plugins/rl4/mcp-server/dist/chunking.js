/**
 * Chunking: evidence.md, timeline.md, decisions.jsonl, chat, cli, code files.
 * Each chunk has stable id, content, metadata (date, tag, source, file, line), citation.
 */
import * as crypto from "crypto";
function stableId(content, source, range) {
    return crypto.createHash("sha256").update(content + source + range, "utf8").digest("hex").slice(0, 24);
}
/** evidence.md: chunks by ASCII dashboard sections (┌─ SECTION_NAME) */
export function chunkEvidence(content, filePath) {
    const chunks = [];
    const lines = content.split("\n");
    let sectionName;
    let sectionStart = 0;
    let sectionLines = [];
    const flushSection = (endLine) => {
        if (!sectionName || sectionLines.length === 0)
            return;
        const chunkContent = sectionLines.join("\n").trim();
        if (!chunkContent)
            return;
        const range = `${sectionStart}-${endLine}`;
        const id = stableId(chunkContent, "evidence", range);
        chunks.push({
            id,
            content: chunkContent,
            metadata: {
                section: sectionName,
                source: "evidence",
                file: filePath,
                line_start: sectionStart,
                line_end: endLine,
            },
            citation: {
                file: filePath,
                line_or_range: `L${sectionStart}-${endLine}`,
                source: "evidence",
            },
        });
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        // Detect section headers: ┌─ SECTION_NAME ──...┐
        const sectionHeader = line.match(/^┌─\s+([A-Z][A-Z &]+)/);
        if (sectionHeader) {
            flushSection(lineNum - 1);
            sectionName = sectionHeader[1].trim();
            sectionStart = lineNum;
            sectionLines = [line];
            continue;
        }
        if (sectionName) {
            sectionLines.push(line);
        }
    }
    // Flush last section
    flushSection(lines.length);
    return chunks;
}
/** timeline.md: chunks by ## Activity Journal, ### YYYY-MM-DD, #### HH:MM – HH:MM */
export function chunkTimeline(content, filePath) {
    const chunks = [];
    const lines = content.split("\n");
    let currentDate;
    let currentSection;
    let chunkStart = 0;
    let chunkLines = [];
    const flushSection = (endLine) => {
        if (chunkLines.length === 0)
            return;
        const chunkContent = chunkLines.join("\n").trim();
        if (!chunkContent)
            return;
        const range = `${chunkStart}-${endLine}`;
        const id = stableId(chunkContent, "timeline", range);
        chunks.push({
            id,
            content: chunkContent,
            metadata: {
                date: currentDate,
                source: "timeline",
                file: filePath,
                line_start: chunkStart,
                line_end: endLine,
                section: currentSection,
            },
            citation: {
                file: filePath,
                line_or_range: `L${chunkStart}-${endLine}`,
                date: currentDate,
                source: "timeline",
            },
        });
        chunkLines = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        if (line.startsWith("## ")) {
            flushSection(lineNum - 1);
            currentSection = line.slice(3).trim();
            currentDate = undefined;
            chunkStart = lineNum;
            chunkLines = [line];
            continue;
        }
        const dateHeader = line.match(/^###\s+(\d{4}-\d{2}-\d{2})/);
        if (dateHeader) {
            flushSection(lineNum - 1);
            currentDate = dateHeader[1];
            currentSection = currentSection ? `${currentSection} / ${line.trim()}` : line.trim();
            chunkStart = lineNum;
            chunkLines = [line];
            continue;
        }
        if (line.match(/^####\s+\d{2}:\d{2}/)) {
            flushSection(lineNum - 1);
            currentSection = line.slice(5).trim();
            chunkStart = lineNum;
            chunkLines = [line];
            continue;
        }
        if (chunkLines.length > 0) {
            chunkLines.push(line);
        }
    }
    flushSection(lines.length);
    return chunks;
}
/** decisions: one chunk per record */
export function chunkDecisions(decisions, filePath) {
    return decisions.map((d) => {
        const content = `${d.intent_text} → ${d.chosen_option} (${d.isoTimestamp})`;
        const range = d.id;
        const id = stableId(content, "decisions", range);
        return {
            id,
            content,
            metadata: {
                date: d.isoTimestamp.slice(0, 10),
                source: "decisions",
                file: filePath,
                thread_id: d.thread_id,
            },
            citation: {
                file: filePath,
                line_or_range: d.id,
                date: d.isoTimestamp,
                source: "decisions",
                thread_id: d.thread_id,
            },
        };
    });
}
/** Max bytes per chat chunk — ensures no single chunk blows up the MCP response */
const CHAT_CHUNK_BYTE_BUDGET = 4000;
/** chat_history.jsonl: chunks by thread (window of messages); metadata thread_id, first_ts, last_ts.
 *  Uses a byte-budget accumulator: flushes when adding another message would exceed CHAT_CHUNK_BYTE_BUDGET. */
export function chunkChat(messages, filePath, messagesPerChunk = 8) {
    var _a, _b, _c;
    const chunks = [];
    const byThread = new Map();
    for (const m of messages) {
        const tid = (_a = m.thread_id) !== null && _a !== void 0 ? _a : "_default";
        if (!byThread.has(tid))
            byThread.set(tid, []);
        byThread.get(tid).push(m);
    }
    for (const [thread_id, msgs] of byThread) {
        let windowStart = 0;
        let windowLines = [];
        let windowBytes = 0;
        const flush = (endIdx) => {
            var _a, _b;
            if (windowLines.length === 0)
                return;
            const content = windowLines.join("\n");
            const first = msgs[windowStart];
            const last = msgs[endIdx - 1];
            const first_ts = (_a = first === null || first === void 0 ? void 0 : first.timestamp) !== null && _a !== void 0 ? _a : "";
            const last_ts = (_b = last === null || last === void 0 ? void 0 : last.timestamp) !== null && _b !== void 0 ? _b : "";
            const range = `${thread_id}:${windowStart}-${endIdx}`;
            const id = stableId(content, "chat", range);
            chunks.push({
                id,
                content,
                metadata: {
                    source: "chat",
                    file: filePath,
                    thread_id,
                    first_ts,
                    last_ts,
                },
                citation: {
                    file: filePath,
                    line_or_range: `${thread_id} ${first_ts}–${last_ts}`,
                    source: "chat",
                    thread_id,
                },
            });
            windowLines = [];
            windowBytes = 0;
            windowStart = endIdx;
        };
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const line = `[${(_b = m.role) !== null && _b !== void 0 ? _b : "?"}] ${((_c = m.text) !== null && _c !== void 0 ? _c : "").slice(0, 800)}`;
            const lineBytes = line.length;
            // Flush if adding this message would exceed budget or message count
            if (windowLines.length > 0 && (windowBytes + lineBytes > CHAT_CHUNK_BYTE_BUDGET || windowLines.length >= messagesPerChunk)) {
                flush(i);
            }
            windowLines.push(line);
            windowBytes += lineBytes;
        }
        flush(msgs.length);
    }
    return chunks;
}
/** cli_history.jsonl: chunks by session or time window (eventsPerChunk commands per chunk) */
export function chunkCli(events, filePath, eventsPerChunk = 20) {
    var _a, _b, _c, _d;
    const chunks = [];
    // Group by session_id, fallback to "_default"
    const bySession = new Map();
    for (const e of events) {
        const sid = (_a = e.session_id) !== null && _a !== void 0 ? _a : "_default";
        if (!bySession.has(sid))
            bySession.set(sid, []);
        bySession.get(sid).push(e);
    }
    for (const [sessionId, sessionEvents] of bySession) {
        for (let i = 0; i < sessionEvents.length; i += eventsPerChunk) {
            const window = sessionEvents.slice(i, i + eventsPerChunk);
            const first = window[0];
            const last = window[window.length - 1];
            const firstDate = (_b = first === null || first === void 0 ? void 0 : first.t) === null || _b === void 0 ? void 0 : _b.slice(0, 10);
            // Format: [tool] command (exit:N, Xms)
            const content = window
                .map((e) => {
                const status = e.exit_code === 0 ? "ok" : `exit:${e.exit_code}`;
                const dur = e.duration_ms > 0 ? ` ${formatDuration(e.duration_ms)}` : "";
                let line = `[${e.tool}] ${e.command} (${status}${dur})`;
                if (e.stdout_preview) {
                    const preview = e.stdout_preview.slice(0, 200).replace(/\n/g, " ").trim();
                    if (preview)
                        line += ` → ${preview}`;
                }
                return line;
            })
                .join("\n");
            const range = `${sessionId}:${i}-${i + window.length}`;
            const id = stableId(content, "cli", range);
            const tools = [...new Set(window.map((e) => e.tool))];
            const tag = tools.length === 1 ? tools[0].toUpperCase() : "CLI";
            chunks.push({
                id,
                content,
                metadata: {
                    date: firstDate,
                    tag,
                    source: "cli",
                    file: filePath,
                    section: `session:${sessionId}`,
                    first_ts: first === null || first === void 0 ? void 0 : first.t,
                    last_ts: last === null || last === void 0 ? void 0 : last.t,
                },
                citation: {
                    file: filePath,
                    line_or_range: `${sessionId} ${(_c = first === null || first === void 0 ? void 0 : first.t) !== null && _c !== void 0 ? _c : ""}–${(_d = last === null || last === void 0 ? void 0 : last.t) !== null && _d !== void 0 ? _d : ""}`,
                    date: firstDate,
                    source: "cli",
                },
            });
        }
    }
    return chunks;
}
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
}
// ═══════════════════════════════════════════════════════════════════════════════
// CODE FILES — chunk content store blobs for RAG-searchable codebase
// ═══════════════════════════════════════════════════════════════════════════════
const CHUNK_LINES = 80;
const OVERLAP_LINES = 15;
// Regex patterns for semantic split points (function/class/method boundaries)
const SPLIT_PATTERNS = [
    /^export\s+(default\s+)?(async\s+)?function\s/, // export function
    /^export\s+(default\s+)?class\s/, // export class
    /^(async\s+)?function\s/, // function
    /^class\s/, // class
    /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, // arrow functions
    /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/, // function expressions
    /^(pub\s+)?(async\s+)?fn\s/, // Rust fn
    /^def\s+\w+/, // Python def
    /^class\s+\w+/, // Python/JS class
    /^(public|private|protected)\s+(static\s+)?(async\s+)?[\w<>]+\s+\w+\s*\(/, // Java/C# methods
    /^func\s+/, // Go func
    /^impl\s+/, // Rust impl
    /^describe\s*\(/, // Test describe
    /^it\s*\(/, // Test it
    /^test\s*\(/, // Test test()
];
function isSplitPoint(line) {
    const trimmed = line.trimStart();
    return SPLIT_PATTERNS.some(p => p.test(trimmed));
}
function detectLanguage(filePath) {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const map = {
        '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.rb': 'ruby',
        '.php': 'php', '.swift': 'swift', '.c': 'c', '.cpp': 'cpp', '.cs': 'csharp',
        '.vue': 'vue', '.svelte': 'svelte', '.prisma': 'prisma', '.sql': 'sql',
        '.sh': 'shell', '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json',
        '.md': 'markdown', '.mdx': 'markdown', '.css': 'css', '.scss': 'scss',
        '.html': 'html', '.graphql': 'graphql', '.proto': 'protobuf',
        '.toml': 'toml', '.dockerfile': 'docker',
    };
    return map[ext] || 'text';
}
/**
 * Chunk a single code file into RAG-searchable IndexedChunks.
 * Strategy:
 * - Small files (≤ CHUNK_LINES): single chunk = whole file
 * - Large files: split at function/class boundaries with OVERLAP_LINES overlap
 * - Fallback: fixed-size windows if no semantic boundaries found
 *
 * Each chunk includes the file path as context so BM25 can match on filenames too.
 */
export function chunkCodeFile(filePath, content) {
    const lines = content.split("\n");
    const lang = detectLanguage(filePath);
    const chunks = [];
    // File header: always prepended so searches for filenames work
    const header = `// file: ${filePath} (${lang}, ${lines.length} lines)`;
    if (lines.length <= CHUNK_LINES) {
        // Small file: one chunk
        const chunkContent = `${header}\n${content}`;
        const id = stableId(chunkContent, "code", `${filePath}:1-${lines.length}`);
        chunks.push({
            id,
            content: chunkContent,
            metadata: {
                source: "code",
                file: filePath,
                line_start: 1,
                line_end: lines.length,
                section: filePath,
                tag: lang.toUpperCase(),
            },
            citation: {
                file: filePath,
                line_or_range: `L1-${lines.length}`,
                source: "code",
            },
        });
        return chunks;
    }
    // Large file: find semantic split points
    const splitPoints = [0]; // always start at line 0
    for (let i = 1; i < lines.length; i++) {
        if (isSplitPoint(lines[i])) {
            // Only split if we've accumulated enough lines since last split
            const lastSplit = splitPoints[splitPoints.length - 1];
            if (i - lastSplit >= CHUNK_LINES / 2) {
                splitPoints.push(i);
            }
        }
    }
    // If no semantic splits found (or too few), fall back to fixed windows
    if (splitPoints.length <= 1) {
        for (let i = 0; i < lines.length; i += CHUNK_LINES - OVERLAP_LINES) {
            const start = i;
            const end = Math.min(i + CHUNK_LINES, lines.length);
            const slice = lines.slice(start, end).join("\n");
            const chunkContent = `${header}\n${slice}`;
            const lineStart = start + 1;
            const lineEnd = end;
            const id = stableId(chunkContent, "code", `${filePath}:${lineStart}-${lineEnd}`);
            chunks.push({
                id,
                content: chunkContent,
                metadata: {
                    source: "code",
                    file: filePath,
                    line_start: lineStart,
                    line_end: lineEnd,
                    section: filePath,
                    tag: lang.toUpperCase(),
                },
                citation: {
                    file: filePath,
                    line_or_range: `L${lineStart}-${lineEnd}`,
                    source: "code",
                },
            });
            if (end >= lines.length)
                break;
        }
        return chunks;
    }
    // Semantic split: chunk between split points, with overlap
    for (let i = 0; i < splitPoints.length; i++) {
        const start = Math.max(0, splitPoints[i] - (i > 0 ? OVERLAP_LINES : 0));
        const end = i < splitPoints.length - 1
            ? Math.min(splitPoints[i + 1] + OVERLAP_LINES, lines.length)
            : lines.length;
        const slice = lines.slice(start, end).join("\n");
        const chunkContent = `${header}\n${slice}`;
        const lineStart = start + 1;
        const lineEnd = end;
        const id = stableId(chunkContent, "code", `${filePath}:${lineStart}-${lineEnd}`);
        chunks.push({
            id,
            content: chunkContent,
            metadata: {
                source: "code",
                file: filePath,
                line_start: lineStart,
                line_end: lineEnd,
                section: filePath,
                tag: lang.toUpperCase(),
            },
            citation: {
                file: filePath,
                line_or_range: `L${lineStart}-${lineEnd}`,
                source: "code",
            },
        });
    }
    return chunks;
}
