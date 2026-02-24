/**
 * Query Processor: intent detection, entity extraction, synonym expansion, source bias.
 * Perplexity Stage 1 — zero external deps, pure regex + hardcoded maps.
 */
export type QueryIntent = "why" | "how" | "what" | "who" | "when" | "list" | "diff" | "general";
export interface QueryAnalysis {
    originalQuery: string;
    normalizedQuery: string;
    intent: QueryIntent;
    intentConfidence: number;
    entities: {
        files: string[];
        dates: string[];
        tags: string[];
        identifiers: string[];
    };
    expandedTerms: string[];
    /** Per-source multiplier: higher = more relevant for this intent */
    sourceBias: Record<string, number>;
}
export declare function analyzeQuery(query: string): QueryAnalysis;
