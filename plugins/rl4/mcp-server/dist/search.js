/**
 * search_context: RAG pipeline — pre-filter → BM25 → RRF → rerank → top K.
 * Returns Perplexity-style structured output: synthesis instruction + smart snippets + relevance + confidence.
 */
import { runRAG } from "./rag.js";
/** Max chars per individual source snippet */
const MAX_SNIPPET_CHARS = 1200;
/** Max total chars for the entire MCP response */
const MAX_TOTAL_CHARS = 15000;
export function searchContext(root, query, filters = {}) {
    const ragFilters = {
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
        file: filters.file,
        limit: filters.limit,
    };
    const result = runRAG(root, query, ragFilters);
    const chunks = result.chunks.map((c) => toSearchChunk(c, query));
    return { chunks, confidence: result.confidence };
}
// ── Smart snippet extraction ─────────────────────────────────────────────────
/** Score a sentence by query term overlap */
function scoreSentence(sentence, queryTerms) {
    const lower = sentence.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
        if (lower.includes(term))
            score += 1;
    }
    // Bonus for shorter, focused sentences (penalize very long lines that match by chance)
    const lengthPenalty = sentence.length > 500 ? 0.8 : 1.0;
    return score * lengthPenalty;
}
/**
 * Extract the most relevant sentences/lines from a chunk's content,
 * keeping context around high-scoring sentences.
 * Returns a focused snippet instead of a blind truncation.
 */
function extractSnippet(content, query, maxChars) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (queryTerms.length === 0 || content.length <= maxChars) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    // Split into sentences/lines
    const lines = content.split(/\n/).filter(l => l.trim().length > 0);
    if (lines.length <= 3) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    // Score each line
    const scored = lines.map((line, idx) => ({ line, idx, score: scoreSentence(line, queryTerms) }));
    // Sort by score descending, pick top lines
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const selectedIndices = new Set();
    let totalLen = 0;
    for (const s of sorted) {
        if (s.score <= 0)
            break;
        // Add the line + 1 context line before and after for coherence
        const contextRange = [Math.max(0, s.idx - 1), s.idx, Math.min(lines.length - 1, s.idx + 1)];
        for (const ci of contextRange) {
            if (!selectedIndices.has(ci)) {
                const lineLen = lines[ci].length + 1;
                if (totalLen + lineLen > maxChars)
                    continue;
                selectedIndices.add(ci);
                totalLen += lineLen;
            }
        }
        if (totalLen >= maxChars * 0.8)
            break;
    }
    // If no lines scored, fall back to first N chars
    if (selectedIndices.size === 0) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    // Reconstruct in original order with gap markers
    const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
    const parts = [];
    let lastIdx = -2;
    for (const idx of sortedIndices) {
        if (idx > lastIdx + 1 && parts.length > 0) {
            parts.push("[…]");
        }
        parts.push(lines[idx]);
        lastIdx = idx;
    }
    return parts.join("\n");
}
// ── Relevance level ──────────────────────────────────────────────────────────
function relevanceLevel(score) {
    if (score >= 0.7)
        return "high";
    if (score >= 0.35)
        return "medium";
    return "low";
}
const RELEVANCE_INDICATOR = {
    high: "●●●",
    medium: "●●○",
    low: "●○○",
};
// ── Chunk formatting ─────────────────────────────────────────────────────────
function toSearchChunk(c, query) {
    const cite = c.citation;
    const snippet = extractSnippet(c.content, query, MAX_SNIPPET_CHARS);
    const excerpt = `[${cite.file} ${cite.line_or_range}${cite.date ? ` | ${cite.date}` : ""}]\n${snippet}`;
    return {
        source: cite.file,
        line_start: c.metadata.line_start,
        line_end: c.metadata.line_end,
        date: cite.date,
        excerpt,
        relevance: relevanceLevel(c.relevanceScore),
    };
}
// ── Confidence label ─────────────────────────────────────────────────────────
function confidenceLabel(confidence) {
    if (confidence >= 0.7)
        return "High confidence — sources strongly match the query";
    if (confidence >= 0.4)
        return "Medium confidence — partial match, some sources may be tangential";
    return "Low confidence — limited matching context found, answer may be incomplete";
}
// ── Perplexity-style output ──────────────────────────────────────────────────
/**
 * Format search results as Perplexity-style stepped output:
 *
 * STEP 1 — SEARCH: Show what was searched and how many results
 * STEP 2 — SOURCES: Numbered sources with smart snippets + relevance bars
 * STEP 3 — SYNTHESIZE: Instruction for the calling LLM to produce cited answer
 *
 * This mirrors Perplexity's visible pipeline: Recherche → Examen des sources → Synthèse.
 * Total output capped to MAX_TOTAL_CHARS.
 */
export function formatPerplexityStyle(query, searchResult, sourceLabel = "development context") {
    const { chunks, confidence } = searchResult;
    if (chunks.length === 0) {
        return `No matching results for "${query}" in ${sourceLabel}.`;
    }
    const lines = [];
    // ── STEP 1: SEARCH ──
    const highCount = chunks.filter(c => c.relevance === "high").length;
    const medCount = chunks.filter(c => c.relevance === "medium").length;
    lines.push(`**Step 1 — Search**: Queried ${sourceLabel} for "${query}"`);
    lines.push(`Found **${chunks.length} sources** (${highCount} high relevance, ${medCount} medium) — ${confidenceLabel(confidence)}\n`);
    // ── STEP 2: SOURCES ──
    lines.push(`**Step 2 — Sources**:\n`);
    let totalChars = lines.join("\n").length;
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const num = i + 1;
        const relBar = RELEVANCE_INDICATOR[c.relevance];
        const sourceHeader = `**[${num}]** ${relBar} ${c.source}${c.date ? ` | ${c.date}` : ""}`;
        let excerpt = c.excerpt;
        const remaining = MAX_TOTAL_CHARS - totalChars - sourceHeader.length - 200;
        if (remaining <= 0) {
            lines.push(`\n*[${chunks.length - i} more sources omitted — refine your query]*`);
            break;
        }
        if (excerpt.length > remaining) {
            excerpt = excerpt.slice(0, remaining) + "…";
        }
        lines.push(sourceHeader);
        lines.push(excerpt);
        lines.push("");
        totalChars += sourceHeader.length + excerpt.length + 2;
    }
    // ── STEP 3: SYNTHESIZE ──
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: Using the ${chunks.length} sources above, produce a concise answer.`);
    lines.push(`- Cite inline as [1], [2], etc. Every factual claim must have a citation.`);
    lines.push(`- Prefer sources marked ●●● (high relevance) over ●○○ (low).`);
    lines.push(`- If sources are insufficient, explicitly state what's missing.`);
    lines.push(`- Be direct and specific. No preamble.`);
    return lines.join("\n");
}
// ── Structured content formatter (for get_evidence, get_timeline, etc.) ─────
/** Max chars for raw content outputs (get_evidence, get_timeline, etc.) */
const MAX_STRUCTURED_CHARS = 15000;
/** Max chars per section in structured output */
const MAX_SECTION_CHARS = 2000;
/**
 * Split markdown content into logical sections (by ## headings, --- separators, or double newlines).
 * Returns sections with their heading (if any) preserved.
 */
function splitIntoSections(content) {
    // Try splitting by ## headings first
    const headingPattern = /^##\s+.+$/gm;
    const headings = [...content.matchAll(headingPattern)];
    if (headings.length >= 2) {
        const sections = [];
        for (let i = 0; i < headings.length; i++) {
            const start = headings[i].index;
            const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
            const block = content.slice(start, end).trim();
            const firstNewline = block.indexOf("\n");
            const heading = firstNewline > 0 ? block.slice(0, firstNewline).replace(/^#+\s*/, "").trim() : block.replace(/^#+\s*/, "").trim();
            const body = firstNewline > 0 ? block.slice(firstNewline + 1).trim() : "";
            if (body.length > 0) {
                sections.push({ heading, body });
            }
        }
        if (sections.length > 0)
            return sections;
    }
    // Fallback: split by --- separators
    const hrParts = content.split(/\n---+\n/).filter(p => p.trim().length > 20);
    if (hrParts.length >= 2) {
        return hrParts.map((part, i) => {
            var _a;
            const lines = part.trim().split("\n");
            const firstLine = ((_a = lines[0]) === null || _a === void 0 ? void 0 : _a.replace(/^[#*\-]+\s*/, "").trim()) || `Section ${i + 1}`;
            return { heading: firstLine.slice(0, 80), body: part.trim() };
        });
    }
    // Fallback: split by double newlines into paragraph groups (~5 paragraphs per section)
    const paragraphs = content.split(/\n{2,}/).filter(p => p.trim().length > 10);
    const PARAS_PER_SECTION = 5;
    const sections = [];
    for (let i = 0; i < paragraphs.length; i += PARAS_PER_SECTION) {
        const group = paragraphs.slice(i, i + PARAS_PER_SECTION);
        const firstLine = group[0].split("\n")[0].replace(/^[#*\-]+\s*/, "").trim().slice(0, 80);
        sections.push({
            heading: firstLine || `Section ${Math.floor(i / PARAS_PER_SECTION) + 1}`,
            body: group.join("\n\n"),
        });
    }
    return sections;
}
/**
 * Format raw content (evidence.md, timeline.md, etc.) as Perplexity-style structured output.
 * Splits into numbered sections, adds synthesis instruction, caps total output.
 *
 * @param contentType - Human-readable label (e.g., "project evidence", "development timeline")
 * @param rawContent - The raw file content
 * @param sourcePath - The source file path (e.g., ".rl4/evidence.md")
 * @param synthesisHint - Context-specific instruction for the LLM
 */
export function formatStructuredContent(contentType, rawContent, sourcePath, synthesisHint) {
    if (!rawContent || rawContent.startsWith("[No ") || rawContent.startsWith("[Supabase")) {
        return rawContent;
    }
    // Strip the "Source: ..." header if present (we'll add our own structured header)
    const content = rawContent.replace(/^Source:\s+\S+\n\n/, "");
    if (content.trim().length === 0) {
        return `No content found in ${sourcePath}.`;
    }
    const sections = splitIntoSections(content);
    if (sections.length === 0) {
        return content.length > MAX_STRUCTURED_CHARS
            ? content.slice(0, MAX_STRUCTURED_CHARS) + "…"
            : content;
    }
    const lines = [];
    // ── STEP 1: IDENTIFY ──
    lines.push(`**Step 1 — Identify**: Loading ${contentType} from \`${sourcePath}\``);
    lines.push(`Found **${sections.length} sections** (${content.length} chars total)\n`);
    // ── STEP 2: SECTIONS ──
    lines.push(`**Step 2 — Sections**:\n`);
    let totalChars = lines.join("\n").length;
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const num = i + 1;
        const header = `**[${num}]** ${s.heading}`;
        let body = s.body;
        if (body.length > MAX_SECTION_CHARS) {
            body = body.slice(0, MAX_SECTION_CHARS) + "…";
        }
        const entry = `${header}\n${body}\n`;
        const remaining = MAX_STRUCTURED_CHARS - totalChars;
        if (remaining <= 100) {
            lines.push(`\n*[${sections.length - i} more sections omitted — use search_context for specific queries]*`);
            break;
        }
        if (entry.length > remaining) {
            lines.push(header);
            lines.push(body.slice(0, remaining - header.length - 20) + "…");
            lines.push(`\n*[${sections.length - i - 1} more sections omitted]*`);
            break;
        }
        lines.push(header);
        lines.push(body);
        lines.push("");
        totalChars += entry.length;
    }
    // ── STEP 3: SYNTHESIZE ──
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: ${synthesisHint}`);
    lines.push(`- Reference sections inline as [1], [2], etc. when answering user questions.`);
    lines.push(`- Prioritize the most recent and relevant sections.`);
    lines.push(`- Be direct and specific. No preamble.`);
    return lines.join("\n");
}
/** Format a decisions list as Perplexity-style stepped output. */
export function formatStructuredDecisions(decisions) {
    if (decisions.length === 0) {
        return "[No decisions found. Decisions are aggregated from CRE interventions, intent graph reversals, and timeline [DECISION] entries.]";
    }
    const lines = [];
    const highCount = decisions.filter(d => d.confidence_gate === "high").length;
    const medCount = decisions.filter(d => d.confidence_gate === "medium").length;
    // Count by source
    const sourceCounts = {};
    for (const d of decisions) {
        const src = d.source || "legacy";
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
    const sourceBreakdown = Object.entries(sourceCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
    // ── STEP 1: IDENTIFY ──
    lines.push(`**Step 1 — Identify**: Aggregated decisions from CRE interventions, intent graph reversals, timeline [DECISION] entries`);
    lines.push(`Found **${decisions.length} decisions** (${highCount} high confidence, ${medCount} medium) — ${sourceBreakdown}\n`);
    // ── STEP 2: DECISIONS ──
    lines.push(`**Step 2 — Decisions**:\n`);
    let totalChars = lines.join("\n").length;
    // Already sorted by caller (most recent first)
    const sorted = decisions;
    for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        const num = i + 1;
        const gate = d.confidence_gate || "unknown";
        const indicator = gate === "high" ? "●●●" : gate === "medium" ? "●●○" : "●○○";
        const srcTag = d.source ? ` [${d.source}]` : "";
        const entry = `**[${num}]** ${indicator} ${d.isoTimestamp || "no date"}${srcTag}\n**Intent**: ${d.intent_text}\n**Chosen**: ${d.chosen_option}\n**Confidence**: ${gate}\n`;
        const remaining = MAX_STRUCTURED_CHARS - totalChars;
        if (remaining <= 100) {
            lines.push(`\n*[${sorted.length - i} more decisions omitted]*`);
            break;
        }
        if (entry.length > remaining) {
            lines.push(`\n*[${sorted.length - i} more decisions omitted]*`);
            break;
        }
        lines.push(entry);
        totalChars += entry.length;
    }
    // ── STEP 3: SYNTHESIZE ──
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: Use these decisions to explain past reasoning. Reference by number [1], [2], etc.`);
    lines.push(`- CRE interventions (●●● accepted, ●○○ rejected) show what context was injected and whether it helped.`);
    lines.push(`- Reversals flag implicit decision changes — code that was written then undone.`);
    lines.push(`- Timeline decisions are explicit choices recorded during development.`);
    lines.push(`- Be direct and specific. No preamble.`);
    return lines.join("\n");
}
/** Format intent_graph JSON as Perplexity-style stepped output. */
export function formatStructuredIntentGraph(rawJson, sourcePath) {
    if (!rawJson || rawJson.startsWith("[No ")) {
        return rawJson;
    }
    // Strip "Source: ..." header if present
    const jsonContent = rawJson.replace(/^Source:\s+\S+\n\n/, "");
    let parsed;
    try {
        parsed = JSON.parse(jsonContent);
    }
    catch {
        return jsonContent.length > MAX_STRUCTURED_CHARS
            ? jsonContent.slice(0, MAX_STRUCTURED_CHARS) + "…"
            : jsonContent;
    }
    // Extract key sections from the graph
    const sections = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
            sections.push({ key, summary: `${value.length} entries` });
        }
        else if (typeof value === "object" && value !== null) {
            sections.push({ key, summary: `${Object.keys(value).length} keys` });
        }
        else {
            sections.push({ key, summary: String(value) });
        }
    }
    const lines = [];
    // ── STEP 1: IDENTIFY ──
    lines.push(`**Step 1 — Identify**: Loading intent graph from \`${sourcePath}\``);
    lines.push(`Found **${sections.length} graph sections** (file chains, hot scores, trajectories)\n`);
    // ── STEP 2: GRAPH DATA ──
    lines.push(`**Step 2 — Graph data**:\n`);
    let totalChars = lines.join("\n").length;
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const num = i + 1;
        const header = `**[${num}]** ${s.key} (${s.summary})`;
        const rawVal = parsed[s.key];
        let body;
        if (typeof rawVal === "string") {
            body = rawVal;
        }
        else {
            body = JSON.stringify(rawVal, null, 2);
        }
        if (body.length > MAX_SECTION_CHARS) {
            body = body.slice(0, MAX_SECTION_CHARS) + "…";
        }
        const entry = `${header}\n\`\`\`json\n${body}\n\`\`\`\n`;
        const remaining = MAX_STRUCTURED_CHARS - totalChars;
        if (remaining <= 100) {
            lines.push(`\n*[${sections.length - i} more sections omitted]*`);
            break;
        }
        if (entry.length > remaining) {
            const truncBody = body.slice(0, remaining - header.length - 40) + "…";
            lines.push(`${header}\n\`\`\`json\n${truncBody}\n\`\`\`\n`);
            lines.push(`\n*[${sections.length - i - 1} more sections omitted]*`);
            break;
        }
        lines.push(entry);
        totalChars += entry.length;
    }
    // ── STEP 3: SYNTHESIZE ──
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: Use the intent graph to explain development patterns. Reference sections [1], [2], etc.`);
    lines.push(`- Identify the most active parts of the codebase (hot scores)`);
    lines.push(`- Explain common file editing patterns (chains)`);
    lines.push(`- Describe development workflow trajectories`);
    return lines.join("\n");
}
