export type LessonType = "AVOID" | "REVERSAL" | "DECISION" | "COUPLING" | "HOTSPOT" | "CHAT";
export interface Lesson {
    id: string;
    type: LessonType;
    text: string;
    origin_file: string;
    origin_prompt_ids: string[];
    evidence_refs: string[];
    first_seen: string;
    last_seen: string;
    source_workspace_id?: string;
}
export interface CouplingEdge {
    fileA: string;
    fileB: string;
    weight: number;
    sources: {
        co_modifications: number;
        shared_prompts: number;
        burst_co_edits: number;
    };
}
export interface ScoreBreakdown {
    causal_proximity: number;
    counterfactual: number;
    temporal: number;
    info_gain: number;
}
export interface ScoredLesson {
    lesson: Lesson;
    crs_score: number;
    density: number;
    density_bucket: number;
    score_breakdown: ScoreBreakdown;
    token_estimate: number;
}
export interface SelectedLesson {
    id: string;
    type: LessonType;
    crs_score: number;
    rank: number;
    density: number;
    density_bucket: number;
    score_breakdown: ScoreBreakdown;
}
export interface CandidateLesson {
    id: string;
    type: LessonType;
    crs_score: number;
    rank: number;
    density: number;
    density_bucket: number;
    drop_reason: "budget" | "max_items" | "low_density";
}
export interface SelectionResult {
    selected: SelectedLesson[];
    candidates: CandidateLesson[];
    budget_tokens: number;
    used_tokens: number;
}
export interface LessonStats {
    injected_ok: number;
    injected_fail: number;
    injected_soft_fail: number;
    baseline_ok: number;
    baseline_fail: number;
    baseline_soft_fail: number;
    triggers: number;
    last_triggered: string;
    first_seen: string;
    type: LessonType;
}
export interface CREState {
    version: string;
    last_updated: string;
    replay_from: string;
    lessons: Record<string, LessonStats>;
    weights: {
        alpha: number;
        beta: number;
        gamma: number;
        delta: number;
    };
    safety: {
        reversal_rate_window_a: number;
        reversal_rate_window_b: number;
        total_interventions: number;
        total_reversed_fast: number;
        total_reworked: number;
        frozen: boolean;
        frozen_reason: string | null;
        frozen_at: string | null;
    };
    kpis: {
        avg_lessons_injected: number;
        avg_edits_before_stable: number;
        trajectory_oscillating_pct: number;
        trajectory_converging_pct: number;
        efficacy_per_lesson: number;
        bypass_rate: number;
    };
    v2_gate_met?: boolean;
    v2_activated_at?: string | null;
    switch_dr_last_estimate?: string | null;
}
export declare const CRE_PARAMS: {
    readonly TOKEN_BUDGET: 300;
    readonly MAX_ITEMS: 4;
    readonly DENSITY_THRESHOLDS: readonly number[];
    readonly MIN_OBS_LEARNING: 5;
    readonly TEMPORAL_CAP: 3;
    readonly EDGE_THRESHOLD: 0.1;
    readonly BUCKET_MIN_OBS: 5;
    readonly V2_GATE: 100;
};
export declare function simHash64(text: string): string;
export declare function stableLessonId(type: LessonType, originFile: string, text: string): string;
/** @deprecated V1 ID format — used for migration from pre-SimHash IDs */
export declare function stableLessonIdV1(type: LessonType, originFile: string, text: string): string;
export declare class CouplingGraph {
    private nodes;
    addEdge(fileA: string, fileB: string, weight: number): void;
    private getOrCreate;
    /**
     * BFS 2-hop causal proximity, modulated by edge weight.
     * d=0 → 1.0, d=1 → 0.5 × w, d=2 → 0.33 × min(w1,w2), d=∞ → 0
     */
    causalProximity(origin: string, target: string): number;
}
/**
 * Build coupling graph from intent_graph.json coupling data + causal_links.
 */
export declare function buildCouplingGraph(couplingPairs: Array<{
    files: string[];
    co_modifications: number;
}>, causalLinks: Array<{
    chat_ref: string;
    file: string;
}>, burstSessions: Array<{
    files: string[];
}>): CouplingGraph;
export declare function assignDensityBucket(density: number): number;
export declare function estimateTokens(text: string): number;
export interface ScoringContext {
    graph: CouplingGraph;
    state: CREState | null;
    targetFile: string;
    avgDaysBetweenSaves: number;
    now: number;
}
export declare function scoreLessons(lessons: Lesson[], ctx: ScoringContext): ScoredLesson[];
/**
 * Greedy submodular selection under token budget with marginal info_gain.
 * Returns selected lessons + unselected candidates.
 */
export declare function selectSubmodular(scored: ScoredLesson[], budget?: number, maxItems?: number): SelectionResult;
export interface SwitchDRResult {
    weights: {
        alpha: number;
        beta: number;
        gamma: number;
        delta: number;
    };
    ate: number;
    confidence: number;
    n_resolved: number;
}
/** Intervention shape expected by SWITCH-DR (matches CREIntervention from cre_learner) */
interface DRIntervention {
    outcome: string;
    selected_lessons: Array<{
        crs_score: number;
        score_breakdown: {
            causal_proximity: number;
            counterfactual: number;
            temporal: number;
            info_gain: number;
        };
    }>;
    candidate_lessons: Array<{
        crs_score: number;
    }>;
    pi_log?: number[];
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
export declare function switchDREstimate(interventions: DRIntervention[], gate?: number): SwitchDRResult | null;
export declare function scoreLessonsAdapted(lessons: Lesson[], ctx: ScoringContext, adaptedWeights?: {
    alpha: number;
    beta: number;
    gamma: number;
    delta: number;
} | null): ScoredLesson[];
export declare function createEmptyCREState(): CREState;
export {};
