/**
 * Auto-generate timeline.md and evidence.md from JSONL evidence files.
 * Pure mechanical truth — zero LLM, zero hallucination.
 *
 * Sources:
 *   - sessions.jsonl   (bursts: files, pattern, duration)
 *   - activity.jsonl    (file saves: path, sha256, linesAdded/Removed)
 *   - chat_threads.jsonl (thread summaries: title, count, timestamps)
 *   - chat_history.jsonl (message count only — not read line by line)
 *   - file_index.json   (content store: file → checksum)
 */
export declare function rebuildTimeline(root: string): string;
export declare function rebuildEvidence(root: string): string;
/**
 * Query JSONL evidence for a specific date range and return rich, forensic detail.
 * This is the "live MCP query" counterpart to the static timeline.md index.
 *
 * Returns structured markdown with:
 * - Per-day breakdown with sessions, files, line counts
 * - Actual chat message summaries (first 200 chars of each assistant message)
 * - Thread titles with message counts
 * - File change details
 */
export declare function queryDateRange(root: string, dateFrom: string, dateTo: string): string;
export declare function rebuildAll(root: string): {
    timelineChars: number;
    evidenceChars: number;
};
