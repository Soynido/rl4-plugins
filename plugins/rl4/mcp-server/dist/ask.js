/**
 * rl4_ask orchestrator: Perplexity-style answer engine for code context.
 * Flow: analyzeQuery → runRAGWithAnalysis → formatAnswerWithCitations → generateRelatedQuestions
 *
 * The MCP server does NOT call an LLM — it returns structured sources + intent-aware synthesis
 * instructions that the calling LLM (Claude, GPT, Gemini, etc.) uses to generate the final answer.
 */
import { analyzeQuery } from "./queryProcessor.js";
import { runRAGWithAnalysis } from "./rag.js";
/** Adaptive snippet size by relevance tier — high-relevance sources get more space */
const SNIPPET_BY_RELEVANCE = {
    high: 1200,
    medium: 600,
    low: 300,
};
/** Max total chars for the whole rl4_ask response */
const MAX_TOTAL_OUTPUT = 12000;
// ── Intent-aware synthesis prompts ──────────────────────────────────────────
// Different intents need different synthesis strategies (like Perplexity adapts its answer style)
const INTENT_PROMPTS = {
    why: `Explain the reasoning and motivation behind the topic. Focus on decisions, trade-offs, and context that led to the choice. Structure: context → decision → rationale.`,
    how: `Explain the implementation approach step by step. Focus on technical details, patterns used, and how components interact. Be concrete with file paths and code references.`,
    what: `Describe what the thing is/does clearly. Focus on purpose, current state, and key characteristics. Start with a one-sentence definition.`,
    when: `Provide a chronological account. Focus on dates, sequence of events, and timeline. Use temporal markers (before/after/during).`,
    who: `Identify the people/roles involved. Focus on contributions, responsibilities, and collaboration patterns.`,
    list: `Provide a structured list or inventory. Use bullet points or numbered items. Be exhaustive based on available sources.`,
    diff: `Compare and contrast the changes. Focus on what changed, what was added/removed, and the before/after state.`,
    general: `Provide a clear, comprehensive answer. Start with the most important information. Be specific and cite every claim.`,
};
// ── Main entry ──────────────────────────────────────────────────────────────
export function ask(root, query, options = {}) {
    var _a;
    const t0 = Date.now();
    // 1. Analyze query
    const analysis = analyzeQuery(query);
    // 2. Build RAG filters
    const filters = {
        source: options.source,
        date_from: options.date_from,
        date_to: options.date_to,
        tag: options.tag,
        limit: (_a = options.limit) !== null && _a !== void 0 ? _a : 5,
    };
    // 3. Run enhanced RAG
    const ragResult = runRAGWithAnalysis(root, analysis, filters);
    // 4. Format answer with numbered citations (Perplexity-style)
    const { answer, sources } = formatAnswerWithCitations(ragResult.chunks, analysis, ragResult.confidence);
    // 5. Generate related questions
    const relatedQuestions = generateRelatedQuestions(analysis, ragResult.chunks);
    return {
        answer,
        confidence: ragResult.confidence,
        analysis: {
            intent: analysis.intent,
            intentConfidence: analysis.intentConfidence,
            entities: analysis.entities,
            expandedTerms: analysis.expandedTerms,
        },
        sources,
        relatedQuestions,
        stats: {
            totalChunks: ragResult.totalChunks,
            filteredChunks: ragResult.filteredChunks,
            returnedChunks: ragResult.chunks.length,
            searchTimeMs: Date.now() - t0,
        },
    };
}
// ── Smart snippet extraction (same technique as search.ts) ───────────────────
function scoreSentence(sentence, queryTerms) {
    const lower = sentence.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
        if (lower.includes(term))
            score += 1;
    }
    return score * (sentence.length > 500 ? 0.8 : 1.0);
}
function extractSnippet(content, query, maxChars) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (queryTerms.length === 0 || content.length <= maxChars) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    const lines = content.split(/\n/).filter(l => l.trim().length > 0);
    if (lines.length <= 3) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    const scored = lines.map((line, idx) => ({ line, idx, score: scoreSentence(line, queryTerms) }));
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const selectedIndices = new Set();
    let totalLen = 0;
    for (const s of sorted) {
        if (s.score <= 0)
            break;
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
    if (selectedIndices.size === 0) {
        return content.length > maxChars ? content.slice(0, maxChars) + "…" : content;
    }
    const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
    const parts = [];
    let lastIdx = -2;
    for (const idx of sortedIndices) {
        if (idx > lastIdx + 1 && parts.length > 0)
            parts.push("[…]");
        parts.push(lines[idx]);
        lastIdx = idx;
    }
    return parts.join("\n");
}
// ── Relevance helpers ────────────────────────────────────────────────────────
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
function confidenceLabel(confidence) {
    if (confidence >= 0.7)
        return "High confidence — sources strongly match the query";
    if (confidence >= 0.4)
        return "Medium confidence — partial match, refine query for better results";
    return "Low confidence — limited matching context, answer may be incomplete";
}
// ── Citation formatter (Perplexity-style) ────────────────────────────────────
function formatAnswerWithCitations(chunks, analysis, confidence) {
    var _a;
    if (chunks.length === 0) {
        return {
            answer: `No results found for "${analysis.originalQuery}". Try a broader query or remove filters.`,
            sources: [],
        };
    }
    const sources = [];
    const lines = [];
    let totalChars = 0;
    const highCount = chunks.filter(c => relevanceLevel(c.relevanceScore) === "high").length;
    const medCount = chunks.filter(c => relevanceLevel(c.relevanceScore) === "medium").length;
    // ── STEP 1: SEARCH ──
    lines.push(`**Step 1 — Search**: Queried codebase for "${analysis.originalQuery}" (intent: ${analysis.intent})`);
    lines.push(`Found **${chunks.length} sources** (${highCount} high relevance, ${medCount} medium) — ${confidenceLabel(confidence)}\n`);
    // ── STEP 2: SOURCES ──
    lines.push(`**Step 2 — Sources**:\n`);
    totalChars += lines.join("\n").length;
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const cite = c.citation;
        const num = i + 1;
        const rel = relevanceLevel(c.relevanceScore);
        const relBar = RELEVANCE_INDICATOR[rel];
        const citationStr = `${cite.file} ${cite.line_or_range}${cite.date ? ` | ${cite.date}` : ""}`;
        // Adaptive: skip low-relevance sources when confidence is high (saves tokens for all users)
        if (confidence >= 0.7 && rel === "low")
            continue;
        // Adaptive snippet size: ●●● get 1200, ●●○ get 600, ●○○ get 300
        const tierMax = SNIPPET_BY_RELEVANCE[rel];
        const remaining = MAX_TOTAL_OUTPUT - totalChars - citationStr.length - 30;
        if (remaining <= 100) {
            lines.push(`\n*[${chunks.length - i} more sources available — use a more specific query]*`);
            break;
        }
        const maxLen = Math.min(tierMax, remaining);
        const snippet = extractSnippet(c.content, analysis.originalQuery, maxLen);
        lines.push(`**[${num}]** ${relBar} ${citationStr}`);
        lines.push(`${snippet}\n`);
        totalChars += citationStr.length + snippet.length + 20;
        sources.push({
            index: num,
            citation: citationStr,
            excerpt: snippet,
            source: cite.source,
            relevance: rel,
            date: cite.date,
        });
    }
    // ── STEP 3: SYNTHESIZE ──
    const intentPrompt = (_a = INTENT_PROMPTS[analysis.intent]) !== null && _a !== void 0 ? _a : INTENT_PROMPTS.general;
    lines.push(`---\n`);
    lines.push(`**Step 3 — Synthesize**: Answer "${analysis.originalQuery}" using the sources above.`);
    lines.push(`**Style**: ${intentPrompt}`);
    lines.push(`- Cite inline as [1], [2]. Prefer ●●● sources. State gaps explicitly. No preamble.`);
    return { answer: lines.join("\n"), sources };
}
// ── Related questions generator ─────────────────────────────────────────────
const RELATED_TEMPLATES = {
    why: [
        "How was {topic} implemented?",
        "What alternatives were considered for {topic}?",
        "When was the decision about {topic} made?",
    ],
    how: [
        "Why was this approach chosen for {topic}?",
        "What issues were found with {topic}?",
        "Show all changes related to {topic}",
    ],
    what: [
        "When was {topic} last modified?",
        "Who worked on {topic}?",
        "How does {topic} work?",
    ],
    when: [
        "What was changed about {topic}?",
        "Why was {topic} modified at that time?",
        "Show the timeline for {topic}",
    ],
    who: [
        "What did they work on related to {topic}?",
        "When was {topic} last modified?",
        "How was {topic} implemented?",
    ],
    list: [
        "Show details about {topic}",
        "When were these changes made?",
        "What decisions were made about {topic}?",
    ],
    diff: [
        "Why were these changes made to {topic}?",
        "When did {topic} change?",
        "Show the timeline for {topic}",
    ],
    general: [
        "What decisions were made about {topic}?",
        "Show the timeline for {topic}",
        "What files are related to {topic}?",
    ],
};
const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "this", "that",
    "these", "those", "it", "its", "i", "we", "you", "they", "he", "she",
    "my", "our", "your", "their", "his", "her", "me", "us", "them",
    "and", "or", "but", "if", "then", "else", "when", "where", "how",
    "what", "which", "who", "why", "not", "no", "so", "as", "at", "by",
    "for", "from", "in", "into", "of", "on", "to", "with", "up", "out",
    "about", "than", "more", "also", "just", "only", "very", "all", "any",
    "each", "every", "some", "many", "much", "most", "other", "own",
    "same", "such", "too", "over", "after", "before", "between",
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou",
    "est", "sont", "pour", "dans", "sur", "avec", "par", "pas", "plus",
    "qui", "que", "quoi", "ce", "cette", "ces", "son", "sa", "ses",
    "mon", "ma", "mes", "ton", "ta", "tes", "nous", "vous", "ils",
    "true", "false", "null", "undefined", "const", "let", "var",
    "function", "return", "import", "export", "from", "new", "class",
    "type", "interface", "string", "number", "boolean", "void", "async",
    "await", "file", "line", "code", "data", "value", "name", "path",
]);
function extractTopicFromChunks(chunks, analysis) {
    var _a, _b, _c;
    if (analysis.entities.identifiers.length > 0)
        return analysis.entities.identifiers[0];
    if (analysis.entities.files.length > 0)
        return analysis.entities.files[0];
    if (chunks.length > 0) {
        const freq = new Map();
        const bigramFreq = new Map();
        const queryWords = new Set(analysis.normalizedQuery.split(/\s+/));
        for (const chunk of chunks) {
            const words = chunk.content
                .toLowerCase()
                .replace(/[^a-zA-Z0-9àâéèêëïîôùûüç_-]/g, " ")
                .split(/\s+/)
                .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !queryWords.has(w));
            const seen = new Set();
            for (const w of words) {
                if (!seen.has(w)) {
                    freq.set(w, ((_a = freq.get(w)) !== null && _a !== void 0 ? _a : 0) + 1);
                    seen.add(w);
                }
            }
            for (let i = 0; i < words.length - 1; i++) {
                const bg = `${words[i]} ${words[i + 1]}`;
                bigramFreq.set(bg, ((_b = bigramFreq.get(bg)) !== null && _b !== void 0 ? _b : 0) + 1);
            }
        }
        const topBigram = [...bigramFreq.entries()]
            .filter(([bg, count]) => count >= 2 && bg.length >= 8)
            .sort((a, b) => b[1] - a[1])[0];
        if (topBigram)
            return topBigram[0];
        const topWord = [...freq.entries()]
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])[0];
        if (topWord)
            return topWord[0];
    }
    const intentWords = new Set(["why", "how", "what", "who", "when", "show", "list", "compare", "diff"]);
    const words = analysis.normalizedQuery
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !intentWords.has(w));
    if (words.length >= 1)
        return words.slice(0, 3).join(" ");
    const fallbacks = {
        why: "this decision", how: "this implementation", what: "this feature",
        when: "this change", who: "this work", list: "this topic",
        diff: "this change", general: "this topic",
    };
    return (_c = fallbacks[analysis.intent]) !== null && _c !== void 0 ? _c : "this topic";
}
function generateRelatedQuestions(analysis, chunks) {
    var _a;
    const questions = [];
    const seen = new Set();
    const add = (q) => { const k = q.toLowerCase(); if (!seen.has(k)) {
        seen.add(k);
        questions.push(q);
    } };
    const topic = extractTopicFromChunks(chunks, analysis);
    // 1. File-specific questions — extract real file names from top chunks
    const files = [...new Set(chunks.slice(0, 5).map((c) => c.metadata.file).filter(Boolean))];
    const codeFiles = files.filter((f) => /\.(ts|js|py|rs|go|tsx|jsx)$/.test(f));
    if (codeFiles.length > 0) {
        const shortName = codeFiles[0].split("/").pop() || codeFiles[0];
        add(`What changed recently in ${shortName}?`);
    }
    if (codeFiles.length > 1) {
        const shortName = codeFiles[1].split("/").pop() || codeFiles[1];
        add(`Why was ${shortName} modified?`);
    }
    // 2. Tag-specific deep dives
    const chunkTags = [...new Set(chunks.map((c) => c.metadata.tag).filter(Boolean))];
    for (const tag of chunkTags.slice(0, 2)) {
        if (tag === "FIX")
            add("What keeps breaking and how was it fixed?");
        else if (tag === "UI")
            add("Show all UI changes and their impact");
        else if (tag === "ARCH")
            add("What architectural decisions were made?");
        else if (tag === "GIT")
            add("Show recent git activity and commits");
        else
            add(`Show all ${tag} entries`);
    }
    // 3. Date-specific — use real dates from chunks
    const chunkDates = [...new Set(chunks.map((c) => { var _a; return (_a = c.metadata.date) !== null && _a !== void 0 ? _a : c.citation.date; }).filter(Boolean))].sort().reverse();
    if (chunkDates.length > 0 && chunkDates[0])
        add(`What happened on ${chunkDates[0]}?`);
    // 4. Section-specific — use metadata.section if available
    const sections = [...new Set(chunks.slice(0, 3).map((c) => c.metadata.section).filter(Boolean))];
    if (sections.length > 0 && sections[0] && sections[0].length < 40) {
        add(`Show details about ${sections[0]}`);
    }
    // 5. Source-type cross-exploration
    const sources = new Set(chunks.map((c) => c.metadata.source));
    if (!sources.has("chat"))
        add("What was discussed about this in past conversations?");
    if (!sources.has("timeline"))
        add(`Show the timeline for ${topic}`);
    if (!sources.has("decisions"))
        add(`What decisions were made about ${topic}?`);
    // 6. Intent-based templates as fallback (only fill remaining slots)
    const templates = (_a = RELATED_TEMPLATES[analysis.intent]) !== null && _a !== void 0 ? _a : RELATED_TEMPLATES.general;
    for (const t of templates) {
        if (questions.length >= 5)
            break;
        add(t.replace("{topic}", topic));
    }
    return questions.slice(0, 5);
}
