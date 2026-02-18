/**
 * search_context: RAG pipeline — pre-filter → BM25 → RRF → rerank → top K, citation source first.
 */
import { runRAG } from "./rag.js";
export function searchContext(root, query, filters = {}) {
    const ragFilters = {
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
        limit: filters.limit,
    };
    const result = runRAG(root, query, ragFilters);
    return result.chunks.map((c) => toSearchChunk(c));
}
/** Format for tool response: citation first + content (same as RAG canonical) */
function toSearchChunk(c) {
    const cite = c.citation;
    const excerpt = `[${cite.file} ${cite.line_or_range}${cite.date ? ` | ${cite.date}` : ""}]\n${c.content}`;
    return {
        source: cite.file,
        line_start: c.metadata.line_start,
        line_end: c.metadata.line_end,
        date: cite.date,
        excerpt,
    };
}
