import { type Lesson } from "./causal_engine.js";
export declare function getWorkspaceRoot(): string;
export declare function getEvidencePath(root: string): string;
export declare function getTimelinePath(root: string): string;
export declare function getDecisionsPath(root: string): string;
export declare function getIntentGraphPath(root: string): string;
/** Read MIG intent_graph.json. Returns formatted string or message if missing. */
export declare function readIntentGraph(root: string): string;
export declare function readFileSafe(filePath: string, encoding?: BufferEncoding): string | null;
export declare function readEvidence(root: string): string;
export declare function readTimeline(root: string): string;
export interface DecisionSummary {
    id: string;
    intent_text: string;
    chosen_option: string;
    confidence_gate: string;
    isoTimestamp: string;
    source?: "decisions.jsonl" | "cre_intervention" | "intent_graph_reversal" | "timeline";
}
export declare function readDecisions(root: string): DecisionSummary[];
/**
 * Aggregate decisions from 3 real sources (+ legacy decisions.jsonl):
 * 1. CRE interventions (.rl4/.internal/cre_interventions.jsonl) — each is a micro-decision
 * 2. Intent Graph reversals (.rl4/intent_graph.json) — implicit decision changes
 * 3. Timeline [DECISION] entries (.rl4/timeline.md) — LLM-written decisions
 * Returns unified DecisionSummary[] sorted by timestamp DESC.
 */
export declare function aggregateDecisions(root: string): DecisionSummary[];
export interface FileLessons {
    reversals: Array<{
        from_v: number;
        to_v: number;
        reverted_lines: number;
        time_gap_hours: number;
    }>;
    hot_score: number;
    trajectory: string;
    avoid_patterns: string[];
    coupled_files: string[];
    past_decisions: string[];
    chat_lessons: string[];
}
/**
 * Load lessons for a specific file from intent_graph.json + skills.mdc + decisions.
 * Used by suggest_edit to inject context before editing.
 */
export declare function loadLessonsForFile(root: string, relPath: string): FileLessons;
export interface AgentAction {
    timestamp: string;
    tool: string;
    file?: string;
    description: string;
    checksum?: string;
    result: 'ok' | 'error';
    error_message?: string;
}
/**
 * Append an agent action to agent_actions.jsonl for proof chain.
 */
export declare function appendAgentAction(root: string, action: AgentAction): void;
export interface CausalLink {
    id: string;
    t: string;
    chat_ref: string;
    file: string;
    delay_ms: number;
    confidence: {
        level: string;
        reason: string;
    };
    burst_id: string;
}
export interface BurstSession {
    burst_id: string;
    t: string;
    files: string[];
    pattern?: {
        type: string;
        confidence: number;
        indicators: string[];
    };
    events_count: number;
    duration_ms: number;
}
export interface IntentGraphData {
    chains: Array<{
        file: string;
        trajectory: string;
        hot_score: number;
        versions: number;
        reversals: number;
        last_reversal: {
            from_v: number;
            to_v: number;
            reverted_lines: number;
            time_gap_hours: number;
        } | null;
        causing_prompts: string[];
    }>;
    coupling: Array<{
        files: string[];
        co_modifications: number;
    }>;
    summary: {
        total_files_tracked: number;
        files_with_reversals: number;
    };
    built_at: string;
}
/** Read causal_links.jsonl → array of CausalLink */
export declare function readCausalLinks(root: string): CausalLink[];
/** Read sessions.jsonl → array of BurstSession (only burst events, not agent_stop) */
export declare function readBurstSessions(root: string): BurstSession[];
/** Read intent_graph.json → typed structure */
export declare function readIntentGraphData(root: string): IntentGraphData | null;
/** Read activity.jsonl (last 200 events) and compute average days between saves for a file */
export declare function computeAvgDaysBetweenSaves(root: string, relPath?: string): number;
/** Read activity.jsonl → last activity timestamp (ISO string) */
export declare function getLastActivityTimestamp(root: string): string | null;
/** Load CRE state from .rl4/.internal/cre_state.json */
export declare function loadCREState(root: string): import("./causal_engine.js").CREState | null;
/** Save CRE state to .rl4/.internal/cre_state.json */
export declare function saveCREState(root: string, state: import("./causal_engine.js").CREState): void;
/** Read recent burst sessions (last N) */
export declare function readRecentBursts(root: string, count: number): BurstSession[];
export declare function formatDecisionsForResource(decisions: DecisionSummary[]): string;
/**
 * Build workspace-wide lessons from all data sources (not file-specific).
 * Used by the one-click snapshot to score and surface top CRE insights.
 */
export declare function buildWorkspaceLessons(root: string): Lesson[];
