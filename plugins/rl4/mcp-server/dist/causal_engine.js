/**
 * CRE — Causal Relevance Engine (V1)
 * Scores and selects lessons for injection into AI coding agents.
 *
 * Patent claim: context selection via causal-distance over a mechanically observed
 * development graph + counterfactual risk reduction from intervention logs +
 * submodular coverage under token budget.
 */
import * as crypto from "crypto";
// ── Hyperparameters ──────────────────────────────────────────────────────────
export const CRE_PARAMS = {
    TOKEN_BUDGET: 300,
    MAX_ITEMS: 4,
    DENSITY_THRESHOLDS: [0.005, 0.01, 0.02, 0.04],
    MIN_OBS_LEARNING: 5,
    TEMPORAL_CAP: 3.0,
    EDGE_THRESHOLD: 0.1, // min weight to create graph edge
    BUCKET_MIN_OBS: 5,
    V2_GATE: 100, // interventions needed before SWITCH-DR weight adaptation activates
};
const TYPE_PRIORS = {
    AVOID: 0.6,
    REVERSAL: 0.4,
    COUPLING: 0.2,
    DECISION: 0.15,
    CHAT: 0.1,
    HOTSPOT: 0.05,
};
const WEIGHTS = { alpha: 0.35, beta: 0.30, gamma: 0.20, delta: 0.15 };
// ── SimHash-64 (V1.1) — Locality-sensitive hash for stable lesson identity ──
// Tolerates minor reformulations: synonyms, reordering, whitespace.
// FNV-1a 64-bit per token → bit accumulator → 16-char hex fingerprint.
const FNV64_OFFSET = BigInt("0xcbf29ce484222325");
const FNV64_PRIME = BigInt("0x100000001b3");
const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);
function fnv1a64(data) {
    let hash = FNV64_OFFSET;
    for (let i = 0; i < data.length; i++) {
        hash ^= BigInt(data.charCodeAt(i));
        hash = (hash * FNV64_PRIME) & MASK64;
    }
    return hash;
}
export function simHash64(text) {
    const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return "0000000000000000";
    // Accumulate weighted bit vectors
    const bits = new Float64Array(64);
    for (const token of tokens) {
        const hash = fnv1a64(token);
        for (let i = 0; i < 64; i++) {
            if ((hash >> BigInt(i)) & BigInt(1)) {
                bits[i] += 1;
            }
            else {
                bits[i] -= 1;
            }
        }
    }
    // Threshold to produce fingerprint
    let fingerprint = BigInt(0);
    for (let i = 0; i < 64; i++) {
        if (bits[i] > 0) {
            fingerprint |= BigInt(1) << BigInt(i);
        }
    }
    return fingerprint.toString(16).padStart(16, "0");
}
// ── Stable Lesson ID (V1.1: SimHash-64) ─────────────────────────────────────
// Format: {type}-{file_prefix}-{simhash16}
// SimHash ensures near-identical lessons map to the same ID even with minor text changes.
export function stableLessonId(type, originFile, text) {
    var _a, _b, _c;
    // File prefix: last path segment, truncated, lowered
    const filePart = (_c = (_b = (_a = originFile.split("/").pop()) === null || _a === void 0 ? void 0 : _a.replace(/\.[^.]+$/, "")) === null || _b === void 0 ? void 0 : _b.toLowerCase().slice(0, 8)) !== null && _c !== void 0 ? _c : "x";
    const hash = simHash64(`${type}|${originFile}|${text}`);
    return `${type.toLowerCase()}-${filePart}-${hash.slice(0, 12)}`;
}
/** @deprecated V1 ID format — used for migration from pre-SimHash IDs */
export function stableLessonIdV1(type, originFile, text) {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
    return `${type.toLowerCase()}-${crypto.createHash("sha256")
        .update(`${type}|${originFile}|${normalized}`)
        .digest("hex").slice(0, 12)}`;
}
export class CouplingGraph {
    constructor() {
        this.nodes = new Map();
    }
    addEdge(fileA, fileB, weight) {
        if (weight < CRE_PARAMS.EDGE_THRESHOLD)
            return;
        this.getOrCreate(fileA).neighbors.set(fileB, weight);
        this.getOrCreate(fileB).neighbors.set(fileA, weight);
    }
    getOrCreate(file) {
        let node = this.nodes.get(file);
        if (!node) {
            node = { neighbors: new Map() };
            this.nodes.set(file, node);
        }
        return node;
    }
    /**
     * BFS 2-hop causal proximity, modulated by edge weight.
     * d=0 → 1.0, d=1 → 0.5 × w, d=2 → 0.33 × min(w1,w2), d=∞ → 0
     */
    causalProximity(origin, target) {
        if (origin === target)
            return 1.0;
        const originNode = this.nodes.get(origin);
        if (!originNode)
            return 0;
        // d=1: direct neighbor
        const w1 = originNode.neighbors.get(target);
        if (w1 !== undefined)
            return 0.5 * w1;
        // d=2: 2-hop via intermediate
        let bestProx = 0;
        for (const [mid, wOriginMid] of originNode.neighbors) {
            const midNode = this.nodes.get(mid);
            if (!midNode)
                continue;
            const wMidTarget = midNode.neighbors.get(target);
            if (wMidTarget !== undefined) {
                const prox = 0.33 * Math.min(wOriginMid, wMidTarget);
                if (prox > bestProx)
                    bestProx = prox;
            }
        }
        return bestProx;
    }
}
/**
 * Build coupling graph from intent_graph.json coupling data + causal_links.
 */
export function buildCouplingGraph(couplingPairs, causalLinks, burstSessions) {
    var _a, _b, _c, _d, _e;
    const graph = new CouplingGraph();
    // Count shared prompts per file pair
    const promptsByChat = new Map();
    for (const link of causalLinks) {
        if (!promptsByChat.has(link.chat_ref))
            promptsByChat.set(link.chat_ref, new Set());
        promptsByChat.get(link.chat_ref).add(link.file);
    }
    const sharedPrompts = new Map();
    for (const files of promptsByChat.values()) {
        const arr = [...files];
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                const key = pairKey(arr[i], arr[j]);
                sharedPrompts.set(key, ((_a = sharedPrompts.get(key)) !== null && _a !== void 0 ? _a : 0) + 1);
            }
        }
    }
    // Count burst co-edits
    const burstCoEdits = new Map();
    for (const session of burstSessions) {
        if (session.files.length < 2)
            continue;
        for (let i = 0; i < session.files.length; i++) {
            for (let j = i + 1; j < session.files.length; j++) {
                const key = pairKey(session.files[i], session.files[j]);
                burstCoEdits.set(key, ((_b = burstCoEdits.get(key)) !== null && _b !== void 0 ? _b : 0) + 1);
            }
        }
    }
    // Build edges: collect all file pairs
    const allPairs = new Set();
    for (const cp of couplingPairs) {
        if (cp.files.length >= 2)
            allPairs.add(pairKey(cp.files[0], cp.files[1]));
    }
    for (const key of sharedPrompts.keys())
        allPairs.add(key);
    for (const key of burstCoEdits.keys())
        allPairs.add(key);
    // Co-modifications lookup
    const coModMap = new Map();
    for (const cp of couplingPairs) {
        if (cp.files.length >= 2) {
            coModMap.set(pairKey(cp.files[0], cp.files[1]), cp.co_modifications);
        }
    }
    for (const key of allPairs) {
        const [fileA, fileB] = key.split("|||");
        const coMods = (_c = coModMap.get(key)) !== null && _c !== void 0 ? _c : 0;
        const sp = (_d = sharedPrompts.get(key)) !== null && _d !== void 0 ? _d : 0;
        const bce = (_e = burstCoEdits.get(key)) !== null && _e !== void 0 ? _e : 0;
        // edge_weight = min(1, co_mods/5×0.4 + shared_prompts/3×0.35 + burst_co_edits/4×0.25)
        const weight = Math.min(1, (coMods / 5) * 0.4 + (sp / 3) * 0.35 + (bce / 4) * 0.25);
        graph.addEdge(fileA, fileB, weight);
    }
    return graph;
}
function pairKey(a, b) {
    return a < b ? `${a}|||${b}` : `${b}|||${a}`;
}
// ── Density Bucket ───────────────────────────────────────────────────────────
export function assignDensityBucket(density) {
    for (let i = 0; i < CRE_PARAMS.DENSITY_THRESHOLDS.length; i++) {
        if (density < CRE_PARAMS.DENSITY_THRESHOLDS[i])
            return i;
    }
    return 4;
}
// ── Token estimation ─────────────────────────────────────────────────────────
export function estimateTokens(text) {
    // ~4 chars per token (conservative)
    return Math.ceil(text.length / 4);
}
export function scoreLessons(lessons, ctx) {
    const scored = [];
    for (const lesson of lessons) {
        const causal_proximity = ctx.graph.causalProximity(lesson.origin_file, ctx.targetFile);
        const counterfactual = computeCounterfactual(lesson, ctx.state);
        const temporal = computeTemporal(lesson, ctx.avgDaysBetweenSaves, ctx.now, ctx.state);
        // Base score (before info_gain, which depends on selection set)
        const base = WEIGHTS.alpha * causal_proximity
            + WEIGHTS.beta * counterfactual
            + WEIGHTS.gamma * temporal;
        const tokenEst = estimateTokens(lesson.text);
        const density = tokenEst > 0 ? base / tokenEst : 0;
        scored.push({
            lesson,
            crs_score: base, // info_gain applied during selection
            density,
            density_bucket: assignDensityBucket(density),
            score_breakdown: { causal_proximity, counterfactual, temporal, info_gain: 0 },
            token_estimate: tokenEst,
        });
    }
    // Sort by density descending for greedy selection
    scored.sort((a, b) => b.density - a.density);
    return scored;
}
function computeCounterfactual(lesson, state) {
    var _a, _b, _c;
    if (!state)
        return (_a = TYPE_PRIORS[lesson.type]) !== null && _a !== void 0 ? _a : 0.1;
    const ls = state.lessons[lesson.id];
    if (!ls)
        return (_b = TYPE_PRIORS[lesson.type]) !== null && _b !== void 0 ? _b : 0.1;
    const failAdj = ls.injected_fail + 0.5 * ls.injected_soft_fail;
    const okAdj = ls.injected_ok + 0.5 * ls.injected_soft_fail;
    const pFailTreated = (failAdj + 1) / (failAdj + okAdj + 2);
    const baseFailAdj = ls.baseline_fail + 0.5 * ls.baseline_soft_fail;
    const baseOkAdj = ls.baseline_ok + 0.5 * ls.baseline_soft_fail;
    const pFailBaseline = (baseFailAdj + 1) / (baseFailAdj + baseOkAdj + 2);
    const ciRaw = pFailBaseline - pFailTreated;
    const nObs = ls.injected_ok + ls.injected_fail + ls.baseline_ok + ls.baseline_fail;
    const prior = ((_c = TYPE_PRIORS[lesson.type]) !== null && _c !== void 0 ? _c : 0.1) * (1 / Math.sqrt(1 + nObs));
    return clamp(ciRaw + prior, 0, 1);
}
function computeTemporal(lesson, avgDaysBetweenSaves, nowMs, state) {
    var _a, _b, _c;
    const lastDate = lesson.last_seen || lesson.first_seen;
    if (!lastDate)
        return 0;
    const deltaMs = nowMs - new Date(lastDate).getTime();
    const deltaDays = Math.max(0, deltaMs / (24 * 3600000));
    const lambdaFile = clamp(1 / Math.max(2, avgDaysBetweenSaves), 0.05, 0.5);
    // Trigger count from CREState — lessons that triggered more get a recency boost
    const triggers = (_c = (_b = (_a = state === null || state === void 0 ? void 0 : state.lessons) === null || _a === void 0 ? void 0 : _a[lesson.id]) === null || _b === void 0 ? void 0 : _b.triggers) !== null && _c !== void 0 ? _c : 1;
    return Math.exp(-lambdaFile * deltaDays) * Math.min(CRE_PARAMS.TEMPORAL_CAP, 1 + Math.log(1 + triggers));
}
// ── Submodular Greedy Selection ──────────────────────────────────────────────
/**
 * Greedy submodular selection under token budget with marginal info_gain.
 * Returns selected lessons + unselected candidates.
 */
export function selectSubmodular(scored, budget = CRE_PARAMS.TOKEN_BUDGET, maxItems = CRE_PARAMS.MAX_ITEMS) {
    const selected = [];
    const remaining = [...scored];
    let usedTokens = 0;
    while (selected.length < maxItems && remaining.length > 0) {
        // Recompute info_gain for remaining candidates
        let bestIdx = -1;
        let bestMarginal = -1;
        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            if (usedTokens + candidate.token_estimate > budget)
                continue;
            const infoGain = computeInfoGain(candidate, selected);
            const marginalScore = candidate.crs_score + WEIGHTS.delta * infoGain;
            const marginalDensity = candidate.token_estimate > 0
                ? marginalScore / candidate.token_estimate
                : 0;
            if (marginalDensity > bestMarginal) {
                bestMarginal = marginalDensity;
                bestIdx = i;
                // Update the candidate's breakdown
                candidate.score_breakdown.info_gain = infoGain;
                candidate.crs_score = candidate.crs_score + WEIGHTS.delta * infoGain;
            }
        }
        if (bestIdx === -1)
            break; // nothing fits budget
        const chosen = remaining.splice(bestIdx, 1)[0];
        usedTokens += chosen.token_estimate;
        selected.push(chosen);
    }
    // Build result
    const selectedResult = selected.map((s, i) => ({
        id: s.lesson.id,
        type: s.lesson.type,
        crs_score: s.crs_score,
        rank: i + 1,
        density: s.density,
        density_bucket: s.density_bucket,
        score_breakdown: s.score_breakdown,
    }));
    const candidateResult = remaining.map((r, i) => ({
        id: r.lesson.id,
        type: r.lesson.type,
        crs_score: r.crs_score,
        rank: selected.length + i + 1,
        density: r.density,
        density_bucket: r.density_bucket,
        drop_reason: (usedTokens + r.token_estimate > budget ? "budget" : "max_items"),
    }));
    return {
        selected: selectedResult,
        candidates: candidateResult,
        budget_tokens: budget,
        used_tokens: usedTokens,
    };
}
function computeInfoGain(candidate, selected) {
    if (selected.length === 0)
        return 1.0;
    let maxOverlap = 0;
    for (const s of selected) {
        let overlap = 0;
        if (candidate.lesson.origin_file === s.lesson.origin_file)
            overlap += 0.5;
        if (candidate.lesson.type === s.lesson.type)
            overlap += 0.3;
        // Same causal chain: share a coupled file
        const sharedCoupled = candidate.lesson.origin_file === s.lesson.origin_file;
        if (sharedCoupled)
            overlap += 0.4;
        overlap = clamp(overlap, 0, 0.8);
        if (overlap > maxOverlap)
            maxOverlap = overlap;
    }
    // Base CRS without info_gain
    const base = candidate.crs_score;
    return base * (1 - maxOverlap);
}
/**
 * SWITCH-DR: Estimate optimal weights from resolved interventions.
 * Returns null if gate not met (not enough data).
 *
 * For each weight dimension (α, β, γ, δ), estimates the gradient of outcome
 * quality w.r.t. that dimension using the doubly-robust estimator:
 *   DR = (Y - μ̂(x)) / π(a|x) + μ̂(x)
 * where Y=outcome, μ̂=direct model estimate, π=propensity from pi_log.
 */
export function switchDREstimate(interventions, gate = CRE_PARAMS.V2_GATE) {
    // Filter to resolved interventions with outcomes
    const resolved = interventions.filter(i => i.outcome === "accepted" || i.outcome === "reversed_fast" || i.outcome === "reworked");
    if (resolved.length < gate)
        return null;
    // Outcome encoding: accepted=1.0, reworked=0.3, reversed_fast=0.0
    function outcomeValue(o) {
        if (o === "accepted")
            return 1.0;
        if (o === "reworked")
            return 0.3;
        return 0.0; // reversed_fast
    }
    // For each dimension, compute the DR gradient
    const dims = ["alpha", "beta", "gamma", "delta"];
    const dimKeys = {
        alpha: "causal_proximity",
        beta: "counterfactual",
        gamma: "temporal",
        delta: "info_gain",
    };
    const newWeights = { ...WEIGHTS };
    let totalATE = 0;
    for (const dim of dims) {
        const breakdownKey = dimKeys[dim];
        let drSum = 0;
        let validCount = 0;
        for (const itv of resolved) {
            if (itv.selected_lessons.length === 0)
                continue;
            const Y = outcomeValue(itv.outcome);
            // Average signal strength for this dimension across selected lessons
            const avgSignal = itv.selected_lessons.reduce((s, l) => { var _a, _b; return s + ((_b = (_a = l.score_breakdown) === null || _a === void 0 ? void 0 : _a[breakdownKey]) !== null && _b !== void 0 ? _b : 0); }, 0) / itv.selected_lessons.length;
            // Direct model estimate: simple average of all outcomes as baseline
            const muHat = 0.7; // prior: most interventions are accepted
            // Propensity: use pi_log if available, else default 1/N
            const avgPi = itv.pi_log && itv.pi_log.length > 0
                ? itv.pi_log.reduce((a, b) => a + b, 0) / itv.pi_log.length
                : 1 / Math.max(1, itv.selected_lessons.length + itv.candidate_lessons.length);
            // Clamp propensity to avoid extreme weights (SWITCH threshold)
            const piClamped = Math.max(0.05, Math.min(0.95, avgPi));
            // DR estimate for this intervention
            const dr = ((Y - muHat) * avgSignal) / piClamped + muHat * avgSignal;
            drSum += dr;
            validCount++;
        }
        if (validCount > 0) {
            const drMean = drSum / validCount;
            // Update weight: shift current weight towards DR-estimated optimal
            // Learning rate decays with sqrt(n) for stability
            const lr = 0.1 / Math.sqrt(validCount / gate);
            const updated = WEIGHTS[dim] + lr * (drMean - WEIGHTS[dim]);
            newWeights[dim] = clamp(updated, 0.1, 0.6);
            totalATE += Math.abs(drMean - WEIGHTS[dim]);
        }
    }
    // Normalize weights to sum to 1
    const wSum = newWeights.alpha + newWeights.beta + newWeights.gamma + newWeights.delta;
    if (wSum > 0) {
        newWeights.alpha /= wSum;
        newWeights.beta /= wSum;
        newWeights.gamma /= wSum;
        newWeights.delta /= wSum;
    }
    return {
        weights: newWeights,
        ate: totalATE / dims.length,
        confidence: Math.min(1, resolved.length / (gate * 2)),
        n_resolved: resolved.length,
    };
}
// ── scoreLessons with optional adapted weights ───────────────────────────────
export function scoreLessonsAdapted(lessons, ctx, adaptedWeights) {
    const w = adaptedWeights !== null && adaptedWeights !== void 0 ? adaptedWeights : WEIGHTS;
    const scored = [];
    for (const lesson of lessons) {
        const causal_proximity = ctx.graph.causalProximity(lesson.origin_file, ctx.targetFile);
        const counterfactual = computeCounterfactual(lesson, ctx.state);
        const temporal = computeTemporal(lesson, ctx.avgDaysBetweenSaves, ctx.now, ctx.state);
        const base = w.alpha * causal_proximity
            + w.beta * counterfactual
            + w.gamma * temporal;
        const tokenEst = estimateTokens(lesson.text);
        const density = tokenEst > 0 ? base / tokenEst : 0;
        scored.push({
            lesson,
            crs_score: base,
            density,
            density_bucket: assignDensityBucket(density),
            score_breakdown: { causal_proximity, counterfactual, temporal, info_gain: 0 },
            token_estimate: tokenEst,
        });
    }
    scored.sort((a, b) => b.density - a.density);
    return scored;
}
// ── Create empty CRE state ──────────────────────────────────────────────────
export function createEmptyCREState() {
    return {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        replay_from: "",
        lessons: {},
        weights: { ...WEIGHTS },
        safety: {
            reversal_rate_window_a: 0,
            reversal_rate_window_b: 0,
            total_interventions: 0,
            total_reversed_fast: 0,
            total_reworked: 0,
            frozen: false,
            frozen_reason: null,
            frozen_at: null,
        },
        kpis: {
            avg_lessons_injected: 0,
            avg_edits_before_stable: 0,
            trajectory_oscillating_pct: 0,
            trajectory_converging_pct: 0,
            efficacy_per_lesson: 0,
            bypass_rate: 0,
        },
    };
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
