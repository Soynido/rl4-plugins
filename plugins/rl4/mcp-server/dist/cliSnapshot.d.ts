export interface CliSnapshotResult {
    ok: boolean;
    prompt: string;
    stats: {
        messages: number;
        threads: number;
        sources: string[];
    };
}
export declare function buildCliSnapshot(workspaceRoot: string): Promise<CliSnapshotResult>;
