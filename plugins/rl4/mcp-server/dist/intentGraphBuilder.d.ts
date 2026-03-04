export interface IntentEvent {
    t: string;
    file: string;
    from_sha256: string | null;
    to_sha256: string;
    delta: {
        linesAdded: number;
        linesRemoved: number;
        netChange: number;
    };
    intent_signal: string;
    causing_prompt: {
        chat_ref: string;
        thread_id: string;
        delay_ms: number;
    } | null;
    burst_id: string | null;
}
export interface ChainVersion {
    sha256: string;
    timestamp: string;
    causing_prompt: IntentEvent["causing_prompt"];
    delta: IntentEvent["delta"];
    intent_signal: string;
    version_index: number;
}
export interface Reversal {
    from_version: number;
    to_version: number;
    reverted_lines: number;
    reversal_ratio: number;
    thread_changed: boolean;
    time_gap_hours: number;
    hunks?: unknown[];
    suggestion_rejected?: boolean;
    suggestion_hash?: string;
}
export type Trajectory = "linear" | "oscillating" | "converging" | "exploring";
/** Shape of each chain entry in the exported intent_graph.json */
export interface IntentGraphChainEntry {
    file: string;
    trajectory: Trajectory;
    hot_score: number;
    versions: number;
    reversals: number;
    last_reversal: {
        from_v: number;
        to_v: number;
        reverted_lines: number;
        thread_changed: boolean;
        time_gap_hours: number;
        hunks?: unknown[];
        suggestion_rejected: boolean;
        suggestion_hash: string | null;
    } | null;
    causing_prompts: string[];
}
export interface Suggestion {
    hash: string;
    content: string;
    old_string?: string;
    intervention_id: string;
    tool_name: string;
}
/**
 * Check if intent_graph.json is stale (older than latest intent_chains event)
 * and rebuild if needed. Returns true if rebuilt.
 */
export declare function rebuildIfStale(root: string): boolean;
export interface Chain {
    file: string;
    versions: ChainVersion[];
    events: IntentEvent[];
    reversals: Reversal[];
    trajectory: Trajectory;
    hot_score: number;
    totalReversals: number;
}
export declare const REVERSAL_WINDOW = 3;
export declare function detectReversalsMetadata(versions: ChainVersion[]): Reversal[];
/** Compute 1-based line ranges that were removed from `before` to produce `after`. */
export declare function getRevertedLineRange(before: string, after: string): Array<{
    start: number;
    end: number;
}>;
export declare function simpleHash(s: string): string;
export declare function enrichReversalsWithBlobDiff(chain: Chain, snapshotsDir: string, suggestions: Map<string, Suggestion[]>): void;
