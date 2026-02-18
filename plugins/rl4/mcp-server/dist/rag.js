/**
 * RAG pipeline: query norm → pre-filter → BM25 + (optional vector) → RRF → rerank → top K → canonical citation first.
 * Phase 4: semantic cache (query + filters → RAG result), LRU eviction.
 */
import * as crypto from "crypto";
import MiniSearch from "minisearch";
import { buildMetadataIndex, filterChunks } from "./indexBuilder.js";
const RRF_K = 60;
const RERANK_WINDOW = 50;
const DEFAULT_TOP_K = 10;
const CACHE_MAX_SIZE = 50;
/** In-memory semantic cache: key = hash(normalizedQuery + filters), value = RAGResult, LRU. */
const semanticCache = new Map();
const cacheKeyOrder = [];
/** Normalize query: lowercase, trim, remove extra spaces */
export function normalizeQuery(query) {
    return query.toLowerCase().trim().replace(/\s+/g, " ");
}
/** Reciprocal Rank Fusion: merge rankings by score_rrf(d) = sum 1/(k + rank_i(d)) */
export function rrf(rankedLists, k = RRF_K) {
    const scores = new Map();
    for (const list of rankedLists) {
        list.forEach((item, rank) => {
            var _a;
            const r = rank + 1;
            const add = 1 / (k + r);
            scores.set(item.id, ((_a = scores.get(item.id)) !== null && _a !== void 0 ? _a : 0) + add);
        });
    }
    return Array.from(scores.entries())
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
}
/** Build BM25 index from chunks (field: content + tag for search) */
function buildBM25Index(chunks) {
    const docs = chunks.map((c) => {
        var _a;
        return ({
            id: c.id,
            content: c.content,
            tag: (_a = c.metadata.tag) !== null && _a !== void 0 ? _a : "",
        });
    });
    const search = new MiniSearch({
        fields: ["content", "tag"],
        storeFields: ["id"],
        searchOptions: {
            boost: { content: 2, tag: 1 },
            prefix: true,
            fuzzy: 0.2,
        },
    });
    search.addAll(docs);
    return search;
}
/** Tokenize for TF-IDF: lowercase, split on non-alphanumeric, min length 2 */
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-zA-Z0-9àâéèêëïîôùûüç_-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2);
}
/**
 * TF-IDF ranking: score(d) = sum over query terms of tf(t,d) * idf(t).
 * idf(t) = log((N+1)/(df(t)+1)). Returns ranked list { id, score } descending.
 */
function rankByTfIdf(chunks, query, topN = RERANK_WINDOW) {
    const terms = tokenize(query);
    if (terms.length === 0)
        return [];
    const N = chunks.length;
    const docFreq = new Map();
    for (const term of new Set(terms)) {
        let df = 0;
        for (const c of chunks) {
            const tokens = tokenize(c.content);
            if (tokens.includes(term))
                df++;
        }
        docFreq.set(term, df);
    }
    const scored = chunks.map((c) => {
        var _a, _b, _c;
        const tokens = tokenize(c.content);
        const tf = new Map();
        for (const t of tokens)
            tf.set(t, ((_a = tf.get(t)) !== null && _a !== void 0 ? _a : 0) + 1);
        let score = 0;
        for (const term of terms) {
            const tfc = (_b = tf.get(term)) !== null && _b !== void 0 ? _b : 0;
            const df = (_c = docFreq.get(term)) !== null && _c !== void 0 ? _c : 0;
            const idf = Math.log((N + 1) / (df + 1));
            score += tfc * idf;
        }
        return { id: c.id, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((s) => ({ id: s.id, score: s.score }));
}
function cacheKey(root, normalizedQuery, filters) {
    const sig = JSON.stringify({
        root,
        q: normalizedQuery,
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
        limit: filters.limit,
    });
    return crypto.createHash("sha256").update(sig, "utf8").digest("hex").slice(0, 32);
}
function cacheGet(key) {
    const v = semanticCache.get(key);
    if (!v)
        return undefined;
    // LRU: move to end
    const i = cacheKeyOrder.indexOf(key);
    if (i >= 0) {
        cacheKeyOrder.splice(i, 1);
        cacheKeyOrder.push(key);
    }
    return v;
}
function cacheSet(key, result) {
    if (semanticCache.has(key)) {
        const i = cacheKeyOrder.indexOf(key);
        if (i >= 0)
            cacheKeyOrder.splice(i, 1);
    }
    while (cacheKeyOrder.length >= CACHE_MAX_SIZE) {
        const evict = cacheKeyOrder.shift();
        if (evict)
            semanticCache.delete(evict);
    }
    semanticCache.set(key, result);
    cacheKeyOrder.push(key);
}
/**
 * Full RAG: cache check → build index → pre-filter → BM25 (top RERANK_WINDOW) → RRF → rerank stub → top K → format → cache.
 */
export function runRAG(root, query, filters = {}) {
    var _a;
    const normalizedQuery = normalizeQuery(query);
    const key = cacheKey(root, normalizedQuery, filters);
    const cached = cacheGet(key);
    if (cached)
        return cached;
    const limit = Math.min((_a = filters.limit) !== null && _a !== void 0 ? _a : DEFAULT_TOP_K, 20);
    const index = buildMetadataIndex(root);
    const filtered = filterChunks(index.chunks, {
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
    });
    if (filtered.length === 0) {
        const empty = { chunks: [], text: `No chunks match filters for query "${query}".` };
        cacheSet(key, empty);
        return empty;
    }
    if (!normalizedQuery) {
        const empty = { chunks: [], text: "Empty query." };
        cacheSet(key, empty);
        return empty;
    }
    const bm25 = buildBM25Index(filtered);
    const bm25Results = bm25.search(normalizedQuery).slice(0, RERANK_WINDOW);
    const bm25Ranked = bm25Results.map((r) => ({ id: r.id }));
    const tfidfRanked = rankByTfIdf(filtered, normalizedQuery, RERANK_WINDOW).map((r) => ({ id: r.id }));
    const rankedIds = rrf([bm25Ranked, tfidfRanked], RRF_K);
    const idToChunk = new Map(filtered.map((c) => [c.id, c]));
    const topIds = rankedIds.slice(0, RERANK_WINDOW).map((x) => x.id);
    const rerankedIds = rerank(topIds, normalizedQuery, idToChunk);
    const topKIds = rerankedIds.slice(0, limit);
    const chunks = topKIds.map((id) => idToChunk.get(id)).filter(Boolean);
    const text = formatCanonical(chunks);
    const result = { chunks, text };
    cacheSet(key, result);
    return result;
}
/** Real reranker: recency + source bias + file match + term overlap. */
function rerank(ids, _query, idToChunk, options = {}) {
    var _a, _b, _c, _d, _e, _f;
    const recencyDays = (_a = options.recencyDays) !== null && _a !== void 0 ? _a : 7;
    const recencyBoost = (_b = options.recencyBoost) !== null && _b !== void 0 ? _b : 1.5;
    const fileMatchBoost = (_c = options.fileMatchBoost) !== null && _c !== void 0 ? _c : 2.0;
    const sourceBias = (_d = options.sourceBias) !== null && _d !== void 0 ? _d : {};
    const queryFiles = (_e = options.queryFiles) !== null && _e !== void 0 ? _e : [];
    const queryTerms = (_f = options.queryTerms) !== null && _f !== void 0 ? _f : [];
    const now = Date.now();
    const msPerDay = 86400000;
    const scored = ids.map((id, position) => {
        var _a, _b;
        const chunk = idToChunk.get(id);
        if (!chunk)
            return { id, score: 0 };
        // Base: inverse position (top = highest)
        let score = 1 / (position + 1);
        // 1. Recency boost
        const chunkDate = (_a = chunk.metadata.date) !== null && _a !== void 0 ? _a : chunk.citation.date;
        if (chunkDate) {
            const daysSince = (now - new Date(chunkDate).getTime()) / msPerDay;
            if (daysSince >= 0) {
                if (daysSince <= recencyDays) {
                    score *= recencyBoost;
                }
                else {
                    // Decay: still some boost if relatively recent
                    score *= Math.max(1.0, recencyBoost * (recencyDays / daysSince));
                }
            }
        }
        // 2. Source bias
        const sourceKey = chunk.metadata.source;
        if (sourceBias[sourceKey]) {
            score *= sourceBias[sourceKey];
        }
        // 3. File match boost
        if (queryFiles.length > 0) {
            const contentLower = chunk.content.toLowerCase();
            const fileLower = ((_b = chunk.metadata.file) !== null && _b !== void 0 ? _b : "").toLowerCase();
            for (const qf of queryFiles) {
                const ql = qf.toLowerCase();
                if (contentLower.includes(ql) || fileLower.includes(ql)) {
                    score *= fileMatchBoost;
                    break;
                }
            }
        }
        // 4. Term overlap: fraction of query terms found in content → 0-0.5 bonus
        if (queryTerms.length > 0) {
            const contentLower = chunk.content.toLowerCase();
            let hits = 0;
            for (const t of queryTerms) {
                if (contentLower.includes(t.toLowerCase()))
                    hits++;
            }
            score += 0.5 * (hits / queryTerms.length);
        }
        return { id, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((s) => s.id);
}
/** Format chunks as canonical: citation source first, then content */
function formatCanonical(chunks) {
    if (chunks.length === 0)
        return "No matching chunks.";
    return chunks
        .map((c) => {
        const cite = c.citation;
        return `[${cite.file} ${cite.line_or_range}${cite.date ? ` | ${cite.date}` : ""}]\n${c.content}`;
    })
        .join("\n\n---\n\n");
}
/**
 * Enhanced RAG pipeline that accepts a QueryAnalysis for intent-aware search.
 * Uses expanded terms for BM25 and passes source bias to the reranker.
 * Backward-compatible: runRAG() still works unchanged for search_context.
 */
export function runRAGWithAnalysis(root, analysis, filters = {}) {
    var _a;
    // Build expanded search query: original terms weighted higher via repetition
    const originalTerms = analysis.normalizedQuery.split(/\s+/).filter(Boolean);
    const expansionOnly = analysis.expandedTerms.filter((t) => !originalTerms.includes(t));
    // Repeat original terms to give them more weight in BM25 (2x original + 1x expanded)
    const searchQuery = [...originalTerms, ...originalTerms, ...expansionOnly.slice(0, 10)].join(" ");
    const normalizedForCache = normalizeQuery(searchQuery);
    const key = cacheKey(root, `ask:${normalizedForCache}`, filters);
    const cached = cacheGet(key);
    if (cached) {
        return { ...cached, analysis, totalChunks: 0, filteredChunks: 0 };
    }
    const limit = Math.min((_a = filters.limit) !== null && _a !== void 0 ? _a : DEFAULT_TOP_K, 20);
    const index = buildMetadataIndex(root);
    const totalChunks = index.chunks.length;
    const filtered = filterChunks(index.chunks, {
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
    });
    const filteredChunks = filtered.length;
    if (filtered.length === 0) {
        const empty = { chunks: [], text: `No chunks match filters for query "${analysis.originalQuery}".` };
        cacheSet(key, empty);
        return { ...empty, analysis, totalChunks, filteredChunks };
    }
    const bm25 = buildBM25Index(filtered);
    const bm25Results = bm25.search(normalizedForCache).slice(0, RERANK_WINDOW);
    const bm25Ranked = bm25Results.map((r) => ({ id: r.id }));
    const tfidfRanked = rankByTfIdf(filtered, normalizedForCache, RERANK_WINDOW).map((r) => ({ id: r.id }));
    const rankedIds = rrf([bm25Ranked, tfidfRanked], RRF_K);
    const idToChunk = new Map(filtered.map((c) => [c.id, c]));
    const topIds = rankedIds.slice(0, RERANK_WINDOW).map((x) => x.id);
    // Real reranker with intent-aware options
    const rerankedIds = rerank(topIds, analysis.normalizedQuery, idToChunk, {
        sourceBias: analysis.sourceBias,
        queryFiles: analysis.entities.files,
        queryTerms: originalTerms,
    });
    const topKIds = rerankedIds.slice(0, limit);
    const chunks = topKIds.map((id) => idToChunk.get(id)).filter(Boolean);
    const text = formatCanonical(chunks);
    const result = { chunks, text };
    cacheSet(key, result);
    return { ...result, analysis, totalChunks, filteredChunks };
}
