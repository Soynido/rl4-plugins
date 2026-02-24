/**
 * rl4_ask orchestrator: Perplexity-style answer engine for code context.
 * Flow: analyzeQuery → runRAGWithAnalysis → formatAnswerWithCitations → generateRelatedQuestions
 *
 * The MCP server does NOT call an LLM — it returns structured sources + intent-aware synthesis
 * instructions that the calling LLM (Claude, GPT, Gemini, etc.) uses to generate the final answer.
 */
import { type QueryAnalysis, type QueryIntent } from "./queryProcessor.js";
export interface AskResult {
    answer: string;
    confidence: number;
    analysis: {
        intent: QueryIntent;
        intentConfidence: number;
        entities: QueryAnalysis["entities"];
        expandedTerms: string[];
    };
    sources: Array<{
        index: number;
        citation: string;
        excerpt: string;
        source: string;
        relevance: "high" | "medium" | "low";
        date?: string;
    }>;
    relatedQuestions: string[];
    stats: {
        totalChunks: number;
        filteredChunks: number;
        returnedChunks: number;
        searchTimeMs: number;
    };
}
export interface AskOptions {
    source?: "evidence" | "timeline" | "decisions" | "chat" | "cli";
    date_from?: string;
    date_to?: string;
    tag?: string;
    limit?: number;
}
export declare function ask(root: string, query: string, options?: AskOptions): AskResult;
