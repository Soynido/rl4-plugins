/**
 * rl4_ask orchestrator: Perplexity-style answer engine for code context.
 * Flow: analyzeQuery → runRAGWithAnalysis → formatAnswerWithCitations → generateRelatedQuestions
 */
import { analyzeQuery } from "./queryProcessor.js";
import { runRAGWithAnalysis } from "./rag.js";
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
    // 4. Format answer with numbered citations
    const { answer, sources } = formatAnswerWithCitations(ragResult.chunks, analysis);
    // 5. Generate related questions
    const relatedQuestions = generateRelatedQuestions(analysis, ragResult.chunks);
    return {
        answer,
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
// ── Citation formatter ──────────────────────────────────────────────────────
function formatAnswerWithCitations(chunks, analysis) {
    if (chunks.length === 0) {
        return {
            answer: `No results found for "${analysis.originalQuery}". Try a broader query or remove filters.`,
            sources: [],
        };
    }
    const sources = [];
    const answerLines = [];
    answerLines.push("## Sources\n");
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const cite = c.citation;
        const num = i + 1;
        const citationStr = `${cite.file} ${cite.line_or_range}${cite.date ? ` | ${cite.date}` : ""}`;
        // Truncate excerpt for readability (first 300 chars)
        const excerpt = c.content.length > 300 ? c.content.slice(0, 300) + "…" : c.content;
        answerLines.push(`**[${num}]** ${citationStr}`);
        answerLines.push(`${excerpt}\n`);
        sources.push({
            index: num,
            citation: citationStr,
            excerpt,
            source: cite.source,
            date: cite.date,
        });
    }
    return { answer: answerLines.join("\n"), sources };
}
// ── Related questions generator ─────────────────────────────────────────────
// Templates per intent
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
// Stopwords for topic extraction (EN + FR + dev noise)
const STOPWORDS = new Set([
    // English
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
    // French
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou",
    "est", "sont", "pour", "dans", "sur", "avec", "par", "pas", "plus",
    "qui", "que", "quoi", "ce", "cette", "ces", "son", "sa", "ses",
    "mon", "ma", "mes", "ton", "ta", "tes", "nous", "vous", "ils",
    // Dev noise
    "true", "false", "null", "undefined", "const", "let", "var",
    "function", "return", "import", "export", "from", "new", "class",
    "type", "interface", "string", "number", "boolean", "void", "async",
    "await", "file", "line", "code", "data", "value", "name", "path",
]);
/** Extract the most meaningful topic from chunks via word frequency analysis */
function extractTopicFromChunks(chunks, analysis) {
    var _a, _b, _c;
    // Priority 1: identifiers from query
    if (analysis.entities.identifiers.length > 0) {
        return analysis.entities.identifiers[0];
    }
    // Priority 2: files from query
    if (analysis.entities.files.length > 0) {
        return analysis.entities.files[0];
    }
    // Priority 3: frequency analysis on chunk content
    if (chunks.length > 0) {
        const freq = new Map();
        // Also collect bigrams
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
            // Bigrams from consecutive non-stopword tokens
            for (let i = 0; i < words.length - 1; i++) {
                const bg = `${words[i]} ${words[i + 1]}`;
                bigramFreq.set(bg, ((_b = bigramFreq.get(bg)) !== null && _b !== void 0 ? _b : 0) + 1);
            }
        }
        // Prefer bigrams that appear in 2+ chunks and are long enough (avoid "is not", "do it")
        const topBigram = [...bigramFreq.entries()]
            .filter(([bg, count]) => count >= 2 && bg.length >= 8)
            .sort((a, b) => b[1] - a[1])[0];
        if (topBigram)
            return topBigram[0];
        // Fallback to top unigram appearing in 2+ chunks
        const topWord = [...freq.entries()]
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])[0];
        if (topWord)
            return topWord[0];
    }
    // Priority 4: meaningful words from query (skip intent words)
    const intentWords = new Set(["why", "how", "what", "who", "when", "show", "list", "compare", "diff"]);
    const words = analysis.normalizedQuery
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !intentWords.has(w));
    if (words.length >= 1) {
        return words.slice(0, 3).join(" ");
    }
    // Fallback: intent-specific so related questions stay actionable
    const fallbacks = {
        why: "this decision",
        how: "this implementation",
        what: "this feature",
        when: "this change",
        who: "this work",
        list: "this topic",
        diff: "this change",
        general: "this topic",
    };
    return (_c = fallbacks[analysis.intent]) !== null && _c !== void 0 ? _c : "this topic";
}
function generateRelatedQuestions(analysis, chunks) {
    var _a;
    const templates = (_a = RELATED_TEMPLATES[analysis.intent]) !== null && _a !== void 0 ? _a : RELATED_TEMPLATES.general;
    const topic = extractTopicFromChunks(chunks, analysis);
    // Extract extra topics from chunk tags and dates
    const chunkTags = [...new Set(chunks.map((c) => c.metadata.tag).filter(Boolean))];
    const chunkDates = [...new Set(chunks.map((c) => { var _a; return (_a = c.metadata.date) !== null && _a !== void 0 ? _a : c.citation.date; }).filter(Boolean))];
    const questions = templates.map((t) => t.replace("{topic}", topic));
    // Add a tag-specific question if we found tags
    if (chunkTags.length > 0 && chunkTags[0]) {
        questions.push(`Show all ${chunkTags[0]} entries`);
    }
    // Add a date-specific question if found
    if (chunkDates.length > 0 && chunkDates[0]) {
        questions.push(`What happened on ${chunkDates[0]}?`);
    }
    // Deduplicate and limit to 5
    return [...new Set(questions)].slice(0, 5);
}
