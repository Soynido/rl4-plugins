import { type CREState, type SelectionResult, type SelectedLesson, type CandidateLesson } from "./causal_engine.js";
export interface OutcomeSignals {
    reversed_fast: boolean;
    reworked: boolean;
    committed: boolean;
    no_touch_minutes: number | null;
    burst_pattern: string | null;
}
export type OutcomeType = "pending" | "reversed_fast" | "reworked" | "accepted" | "indeterminate";
export interface CREIntervention {
    intervention_id: string;
    cre_version: string;
    timestamp: string;
    file: string;
    burst_id: string | null;
    selected_lessons: SelectedLesson[];
    candidate_lessons: CandidateLesson[];
    budget_tokens: number;
    used_tokens: number;
    outcome: OutcomeType;
    outcome_resolved_at: string | null;
    outcome_signals: OutcomeSignals | null;
    /** V1.1: Normalized propensity for each selected lesson — pi_log[i] = crs_score[i] / sum(all_scores).
     *  Required for SWITCH-DR (V2). Backward compat: old interventions without pi_log default to 1/N. */
    pi_log?: number[];
}
export declare function logIntervention(root: string, file: string, selection: SelectionResult, burstId?: string | null): string | null;
/**
 * Resolve pending interventions for a given file.
 * Called on file save, burst flush, and commit detection.
 */
export declare function resolveOutcomes(root: string, files: string[]): void;
export declare function recomputeStateFromLogs(root: string): CREState;
export declare function readAllInterventions(root: string): CREIntervention[];
