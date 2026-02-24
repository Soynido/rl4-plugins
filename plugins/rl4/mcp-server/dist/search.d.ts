export interface SearchFilters {
    source?: "evidence" | "timeline" | "decisions" | "chat" | "cli";
    file?: string;
    date_from?: string;
    date_to?: string;
    tag?: string;
    limit?: number;
}
export interface SearchChunk {
    source: string;
    line_start?: number;
    line_end?: number;
    date?: string;
    excerpt: string;
    /** Relevance: "high" | "medium" | "low" — based on normalized rerank score */
    relevance: "high" | "medium" | "low";
}
export declare function searchContext(root: string, query: string, filters?: SearchFilters): {
    chunks: SearchChunk[];
    confidence: number;
};
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
export declare function formatPerplexityStyle(query: string, searchResult: {
    chunks: SearchChunk[];
    confidence: number;
}, sourceLabel?: string): string;
/**
 * Format raw content (evidence.md, timeline.md, etc.) as Perplexity-style structured output.
 * Splits into numbered sections, adds synthesis instruction, caps total output.
 *
 * @param contentType - Human-readable label (e.g., "project evidence", "development timeline")
 * @param rawContent - The raw file content
 * @param sourcePath - The source file path (e.g., ".rl4/evidence.md")
 * @param synthesisHint - Context-specific instruction for the LLM
 */
export declare function formatStructuredContent(contentType: string, rawContent: string, sourcePath: string, synthesisHint: string): string;
/** Format a decisions list as Perplexity-style stepped output. */
export declare function formatStructuredDecisions(decisions: Array<{
    id: string;
    isoTimestamp: string;
    intent_text: string;
    chosen_option: string;
    confidence_gate: string;
    source?: string;
}>): string;
/** Format intent_graph JSON as Perplexity-style stepped output. */
export declare function formatStructuredIntentGraph(rawJson: string, sourcePath: string): string;
