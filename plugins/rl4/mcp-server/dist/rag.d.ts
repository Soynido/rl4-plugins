import type { IndexedChunk } from "./chunking.js";
import type { QueryAnalysis } from "./queryProcessor.js";
export interface RAGFilters {
    source?: "evidence" | "timeline" | "decisions" | "chat" | "cli";
    date_from?: string;
    date_to?: string;
    tag?: string;
    file?: string;
    limit?: number;
}
/** Normalize query: lowercase, trim, remove extra spaces */
export declare function normalizeQuery(query: string): string;
/** Reciprocal Rank Fusion: merge rankings by score_rrf(d) = sum 1/(k + rank_i(d)) */
export declare function rrf(rankedLists: Array<Array<{
    id: string;
}>>, k?: number): Array<{
    id: string;
    score: number;
}>;
export interface ScoredChunk extends IndexedChunk {
    /** Relevance score (0-1 normalized) from RRF + rerank pipeline */
    relevanceScore: number;
}
export interface RAGResult {
    chunks: ScoredChunk[];
    /** Citation-first text for each chunk */
    text: string;
    /** Overall confidence: ratio of top-scored chunk to perfect score, 0-1 */
    confidence: number;
}
/**
 * Full RAG: cache check → build index → pre-filter → BM25 (top RERANK_WINDOW) → RRF → rerank → top K → format → cache.
 * Uses engine cache for BM25 + TF-IDF to avoid rebuilding on every query.
 */
export declare function runRAG(root: string, query: string, filters?: RAGFilters): RAGResult;
export interface RerankOptions {
    /** Days within which chunks get recency boost (default 7) */
    recencyDays?: number;
    /** Multiplier for recent chunks (default 1.5) */
    recencyBoost?: number;
    /** Per-source multipliers from QueryProcessor */
    sourceBias?: Record<string, number>;
    /** Boost for chunks mentioning query-extracted files (default 2.0) */
    fileMatchBoost?: number;
    /** File paths extracted from the query */
    queryFiles?: string[];
    /** Query terms for term-overlap scoring */
    queryTerms?: string[];
}
export interface RAGResultEnhanced extends RAGResult {
    analysis: QueryAnalysis;
    totalChunks: number;
    filteredChunks: number;
}
/**
 * Enhanced RAG pipeline that accepts a QueryAnalysis for intent-aware search.
 * Uses expanded terms for BM25 and passes source bias to the reranker.
 * Backward-compatible: runRAG() still works unchanged for search_context.
 */
export declare function runRAGWithAnalysis(root: string, analysis: QueryAnalysis, filters?: RAGFilters): RAGResultEnhanced;
/**
 * Warm up the engine cache on startup: build MetadataIndex + BM25 + TF-IDF.
 * Called once after server connect so the first user query is instant.
 */
export declare function warmUpEngine(root: string): {
    chunks: number;
    timeMs: number;
};
