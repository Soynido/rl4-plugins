export interface ScanResult {
    files: Array<{
        relativePath: string;
        absolutePath: string;
        sizeBytes: number;
    }>;
    scannedDirs: number;
    skippedDirs: number;
    skippedFiles: number;
    scanTimeMs: number;
    truncated: boolean;
}
/**
 * Scan workspace directory for source files.
 * Fast: skips node_modules/.git immediately, respects .gitignore, caps at MAX_FILES.
 */
export declare function scanWorkspace(root: string): ScanResult;
