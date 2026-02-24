/**
 * RAG pipeline: query norm → pre-filter → BM25 + (optional vector) → RRF → rerank → top K → canonical citation first.
 * Phase 4: semantic cache (query + filters → RAG result), LRU eviction.
 */
import * as crypto from "crypto";
import MiniSearch from "minisearch";
import { buildMetadataIndex, filterChunks, getIndexSignature } from "./indexBuilder.js";
const RRF_K = 60;
const RERANK_WINDOW = 50;
const DEFAULT_TOP_K = 10;
const CACHE_MAX_SIZE = 50;
/** In-memory semantic cache: key = hash(normalizedQuery + filters), value = RAGResult, LRU. */
const semanticCache = new Map();
const cacheKeyOrder = [];
let engineCache = null;
function getOrBuildEngine(root, filtered) {
    var _a, _b, _c, _d, _e;
    const sig = getIndexSignature(root);
    // Fast identity check: same index data + same chunk count + same first/last IDs
    // This covers the common case (no filters, same data) without hashing all IDs
    const identity = `${filtered.length}:${(_b = (_a = filtered[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : ""}:${(_d = (_c = filtered[filtered.length - 1]) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : ""}`;
    if (engineCache && engineCache.indexSig === sig && engineCache.filterHash === identity) {
        return engineCache;
    }
    // Build BM25 index
    const bm25 = buildBM25Index(filtered);
    // Pre-tokenize all chunks for TF-IDF
    const chunkTF = new Array(filtered.length);
    for (let i = 0; i < filtered.length; i++) {
        const c = filtered[i];
        const tokens = tokenize(c.content);
        const tf = new Map();
        for (const t of tokens)
            tf.set(t, ((_e = tf.get(t)) !== null && _e !== void 0 ? _e : 0) + 1);
        chunkTF[i] = { id: c.id, tf, tokenSet: new Set(tf.keys()) };
    }
    const idToChunk = new Map(filtered.map((c) => [c.id, c]));
    engineCache = { indexSig: sig, filterHash: identity, bm25, chunkTF, filtered, idToChunk };
    return engineCache;
}
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
    var _a;
    // Deduplicate by chunk ID (safety net — same file can be indexed via snapshot + live scan)
    const seen = new Set();
    const docs = [];
    for (const c of chunks) {
        if (seen.has(c.id))
            continue;
        seen.add(c.id);
        docs.push({ id: c.id, content: c.content, tag: (_a = c.metadata.tag) !== null && _a !== void 0 ? _a : "" });
    }
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
 * TF-IDF ranking using pre-cached tokenization data from engine cache.
 * O(terms × N) for df + O(N × terms) for scoring — no tokenization at query time.
 */
function rankByTfIdfCached(precomputed, query, topN = RERANK_WINDOW) {
    var _a, _b;
    const terms = tokenize(query);
    if (terms.length === 0)
        return [];
    const N = precomputed.length;
    const uniqueTerms = new Set(terms);
    // Compute document frequency using pre-cached token sets
    const docFreq = new Map();
    for (const term of uniqueTerms) {
        let df = 0;
        for (let i = 0; i < N; i++) {
            if (precomputed[i].tokenSet.has(term))
                df++;
        }
        docFreq.set(term, df);
    }
    // Score using pre-cached TF maps
    const scored = [];
    for (let i = 0; i < N; i++) {
        const { id, tf } = precomputed[i];
        let score = 0;
        for (const term of terms) {
            const tfc = (_a = tf.get(term)) !== null && _a !== void 0 ? _a : 0;
            if (tfc === 0)
                continue;
            const df = (_b = docFreq.get(term)) !== null && _b !== void 0 ? _b : 0;
            const idf = Math.log((N + 1) / (df + 1));
            score += tfc * idf;
        }
        if (score > 0)
            scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.length <= topN ? scored : scored.slice(0, topN);
}
function cacheKey(root, normalizedQuery, filters) {
    const sig = JSON.stringify({
        root,
        q: normalizedQuery,
        source: filters.source,
        date_from: filters.date_from,
        date_to: filters.date_to,
        tag: filters.tag,
        file: filters.file,
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
 * Full RAG: cache check → build index → pre-filter → BM25 (top RERANK_WINDOW) → RRF → rerank → top K → format → cache.
 * Uses engine cache for BM25 + TF-IDF to avoid rebuilding on every query.
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
        file: filters.file,
    });
    if (filtered.length === 0) {
        const empty = { chunks: [], text: `No chunks match filters for query "${query}".`, confidence: 0 };
        cacheSet(key, empty);
        return empty;
    }
    if (!normalizedQuery) {
        const empty = { chunks: [], text: "Empty query.", confidence: 0 };
        cacheSet(key, empty);
        return empty;
    }
    // Use engine cache: BM25 index + pre-tokenized TF-IDF (avoids ~1.8s rebuild)
    const engine = getOrBuildEngine(root, filtered);
    const bm25Results = engine.bm25.search(normalizedQuery).slice(0, RERANK_WINDOW);
    const bm25Ranked = bm25Results.map((r) => ({ id: r.id }));
    const tfidfRanked = rankByTfIdfCached(engine.chunkTF, normalizedQuery, RERANK_WINDOW).map((r) => ({ id: r.id }));
    const rankedIds = rrf([bm25Ranked, tfidfRanked], RRF_K);
    const topIds = rankedIds.slice(0, RERANK_WINDOW).map((x) => x.id);
    const rerankedScored = rerankWithScores(topIds, normalizedQuery, engine.idToChunk);
    const topK = rerankedScored.slice(0, limit);
    const maxScore = topK.length > 0 ? topK[0].score : 1;
    const scoredChunks = topK
        .map((s) => {
        const chunk = engine.idToChunk.get(s.id);
        if (!chunk)
            return null;
        return { ...chunk, relevanceScore: maxScore > 0 ? s.score / maxScore : 0 };
    })
        .filter(Boolean);
    const rrfScores = rankedIds.slice(0, limit).map((r) => r.score);
    const confidence = rrfScores.length > 0
        ? Math.min(1, rrfScores[0] / (2 / (RRF_K + 1)))
        : 0;
    const text = formatCanonical(scoredChunks);
    const result = { chunks: scoredChunks, text, confidence };
    cacheSet(key, result);
    return result;
}
/** Real reranker: recency + source bias + file match + term overlap. Returns scores for relevance display. */
function rerankWithScores(ids, _query, idToChunk, options = {}) {
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
    return scored.sort((a, b) => b.score - a.score);
}
/** Backward-compatible wrapper that returns only IDs */
function rerank(ids, query, idToChunk, options = {}) {
    return rerankWithScores(ids, query, idToChunk, options).map((s) => s.id);
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
        file: filters.file,
    });
    const filteredChunks = filtered.length;
    if (filtered.length === 0) {
        const empty = { chunks: [], text: `No chunks match filters for query "${analysis.originalQuery}".`, confidence: 0 };
        cacheSet(key, empty);
        return { ...empty, analysis, totalChunks, filteredChunks };
    }
    // Use engine cache: BM25 index + pre-tokenized TF-IDF (avoids ~1.8s rebuild)
    const engine = getOrBuildEngine(root, filtered);
    const bm25Results = engine.bm25.search(normalizedForCache).slice(0, RERANK_WINDOW);
    const bm25Ranked = bm25Results.map((r) => ({ id: r.id }));
    const tfidfRanked = rankByTfIdfCached(engine.chunkTF, normalizedForCache, RERANK_WINDOW).map((r) => ({ id: r.id }));
    const rankedIds = rrf([bm25Ranked, tfidfRanked], RRF_K);
    const topIds = rankedIds.slice(0, RERANK_WINDOW).map((x) => x.id);
    // Real reranker with intent-aware options — returns scores
    const rerankedScored = rerankWithScores(topIds, analysis.normalizedQuery, engine.idToChunk, {
        sourceBias: analysis.sourceBias,
        queryFiles: analysis.entities.files,
        queryTerms: originalTerms,
    });
    const topK = rerankedScored.slice(0, limit);
    const maxScore = topK.length > 0 ? topK[0].score : 1;
    const scoredChunks = topK
        .map((s) => {
        const chunk = engine.idToChunk.get(s.id);
        if (!chunk)
            return null;
        return { ...chunk, relevanceScore: maxScore > 0 ? s.score / maxScore : 0 };
    })
        .filter(Boolean);
    const rrfScores = rankedIds.slice(0, limit).map((r) => r.score);
    const confidence = rrfScores.length > 0
        ? Math.min(1, rrfScores[0] / (2 / (RRF_K + 1)))
        : 0;
    const text = formatCanonical(scoredChunks);
    const result = { chunks: scoredChunks, text, confidence };
    cacheSet(key, result);
    return { ...result, analysis, totalChunks, filteredChunks };
}
/**
 * Warm up the engine cache on startup: build MetadataIndex + BM25 + TF-IDF.
 * Called once after server connect so the first user query is instant.
 */
export function warmUpEngine(root) {
    const t0 = Date.now();
    const index = buildMetadataIndex(root);
    const filtered = filterChunks(index.chunks, {}); // no filters = all chunks (common case)
    getOrBuildEngine(root, filtered);
    return { chunks: index.chunks.length, timeMs: Date.now() - t0 };
}
