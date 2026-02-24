export type ChunkSource = "evidence" | "timeline" | "decisions" | "chat" | "cli" | "code";
export interface ChunkMetadata {
    date?: string;
    tag?: string;
    source: ChunkSource;
    file: string;
    line_start?: number;
    line_end?: number;
    section?: string;
    thread_id?: string;
    first_ts?: string;
    last_ts?: string;
}
export interface IndexedChunk {
    id: string;
    content: string;
    metadata: ChunkMetadata;
    /** Citation: file, line_or_range, date, source — for "source first" output */
    citation: {
        file: string;
        line_or_range: string;
        date?: string;
        source: ChunkSource;
        thread_id?: string;
    };
}
/** evidence.md: chunks by ASCII dashboard sections (┌─ SECTION_NAME) */
export declare function chunkEvidence(content: string, filePath: string): IndexedChunk[];
/** timeline.md: chunks by ## Activity Journal, ### YYYY-MM-DD, #### HH:MM – HH:MM */
export declare function chunkTimeline(content: string, filePath: string): IndexedChunk[];
export interface DecisionRecord {
    id: string;
    intent_text: string;
    chosen_option: string;
    confidence_gate?: string;
    isoTimestamp: string;
    thread_id?: string;
}
/** decisions: one chunk per record */
export declare function chunkDecisions(decisions: DecisionRecord[], filePath: string): IndexedChunk[];
/** chat_history.jsonl: chunks by thread (window of messages); metadata thread_id, first_ts, last_ts.
 *  Uses a byte-budget accumulator: flushes when adding another message would exceed CHAT_CHUNK_BYTE_BUDGET. */
export declare function chunkChat(messages: Array<{
    thread_id?: string;
    timestamp?: string;
    role?: string;
    text?: string;
}>, filePath: string, messagesPerChunk?: number): IndexedChunk[];
/** CLI event from cli_history.jsonl */
export interface CliEventRecord {
    t: string;
    command: string;
    tool: string;
    exit_code: number;
    duration_ms: number;
    cwd: string;
    stdout_preview?: string;
    stderr_preview?: string;
    session_id?: string;
}
/** cli_history.jsonl: chunks by session or time window (eventsPerChunk commands per chunk) */
export declare function chunkCli(events: CliEventRecord[], filePath: string, eventsPerChunk?: number): IndexedChunk[];
/**
 * Chunk a single code file into RAG-searchable IndexedChunks.
 * Strategy:
 * - Small files (≤ CHUNK_LINES): single chunk = whole file
 * - Large files: split at function/class boundaries with OVERLAP_LINES overlap
 * - Fallback: fixed-size windows if no semantic boundaries found
 *
 * Each chunk includes the file path as context so BM25 can match on filenames too.
 */
export declare function chunkCodeFile(filePath: string, content: string): IndexedChunk[];
