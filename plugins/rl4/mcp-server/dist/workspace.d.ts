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
export interface FileHistoryReversal {
    t: string;
    added_sha: string;
    removed_sha: string;
    reverted_lines: number;
    time_gap_hours: number;
}
export interface FileHistoryChatMention {
    thread_title: string;
    source: string;
    date: string;
}
export interface RiskEpisode {
    signal: string;
    t: string;
    score: number;
    detail: string;
}
export interface ActivityEvent {
    t: number;
    linesAdded: number;
    linesRemoved: number;
}
export interface IntentTransition {
    t: number;
    intent_signal: string;
}
export interface FileHistory {
    versions_count: number;
    first_seen: string;
    last_modified: string;
    reversals: FileHistoryReversal[];
    chat_mentions: FileHistoryChatMention[];
    dynamic_warnings: string[];
    hot_score: number;
    trajectory: string;
    risk_score: number;
    risk_episodes: RiskEpisode[];
    lifetime_efficiency: number;
}
/**
 * Universal Risk Model — 5-layer Laplace-smoothed risk scoring.
 * Pure function, O(n), synchronous, ~2ms on typical input (~200 events).
 * Based on Code Thrashing research (Nagappan & Ball 2005) + Lehman's Law.
 */
export declare function computeFileRisk(events: ActivityEvent[], transitions: IntentTransition[]): {
    score: number;
    episodes: RiskEpisode[];
    lifetime_eff: number;
};
/**
 * Read a ContentStore blob by SHA-256 checksum.
 * Tries plain .content first, then .content.gz.
 * Returns null if blob not found.
 */
export declare function readBlobSafe(root: string, sha256: string): string | null;
/**
 * Extract lines that were added in `addedBlob` but absent in `removedBlob`.
 * These are the "reverted lines" — code that was written then undone.
 * Filters out: short lines (<10 chars), pure syntax, whitespace-only.
 */
export declare function extractRevertedLines(addedBlob: string, removedBlob: string): string[];
/**
 * Reconstruct the full mechanical history of a file from RL4 evidence.
 * PERF: Uses fast sources (intent_graph.json ~5ms, file_index.json ~2ms,
 * intent_chains.jsonl ~20ms, chat_threads.jsonl ~5ms, activity.jsonl ~30ms with pre-filter).
 * Total budget: ~64ms. Does NOT read chat_history.jsonl (31MB).
 * Blob reading limited to last 3 reversals, only if hot_score > 0.5.
 * Risk model: 5-layer Laplace-smoothed scoring from activity + intent transitions.
 */
export declare function reconstructFileHistory(root: string, relPath: string): FileHistory;
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
export interface LineHunkData {
    startOld: number;
    countOld: number;
    startNew: number;
    countNew: number;
    lines: string[];
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
            thread_changed?: boolean;
            hunks?: LineHunkData[];
            suggestion_rejected?: boolean;
            suggestion_hash?: string;
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
/**
 * Rewrite absolute paths in remote context content to local equivalents.
 * Called when a user reads another user's context via Supabase — the evidence
 * and timeline contain absolute paths from the owner's machine.
 *
 * Detection: finds the first absolute path (/Users/X/... or /home/X/...) and
 * infers the remote root from a `/.rl4/` boundary. If the remote root differs
 * from localRoot, all occurrences are replaced.
 *
 * No-op when: no absolute paths, same root, or root can't be detected.
 */
export declare function rewriteRemotePaths(content: string, localRoot: string): string;
