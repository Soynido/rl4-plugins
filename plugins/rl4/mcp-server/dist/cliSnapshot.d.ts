interface ScanItem {
    unixMs: number;
    generationUUID: string;
    type: "composer" | "assistant";
    textDescription: string;
    provider?: string;
    transcript_ref?: string;
    preview?: string;
}
interface ThreadSummary {
    thread_key: string;
    title?: string;
    provider?: string;
    count: number;
    firstMs: number;
    lastMs: number;
}
interface ScanResult {
    source: string;
    note?: string;
    items: ScanItem[];
    threads: ThreadSummary[];
}
export interface CliSnapshotResult {
    ok: boolean;
    prompt: string;
    stats: {
        messages: number;
        threads: number;
        sources: string[];
    };
}
/** Scan Cursor workspace DB + global DB for chat history */
export declare function scanCursorDb(workspaceRoot: string, limit?: number): Promise<ScanResult>;
export declare function buildCliSnapshot(workspaceRoot: string): Promise<CliSnapshotResult>;
export {};
