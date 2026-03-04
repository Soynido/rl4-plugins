/**
 * Idempotent mkdir — catches EEXIST from concurrent creators.
 */
export declare function ensureDirSync(dir: string): void;
/**
 * Acquire lock → append line (with trailing \n) → release.
 * Safe for concurrent appenders across processes.
 * Default: fail soft (throwOnFail=false) — logs warning, returns gracefully.
 */
export declare function lockedAppend(filePath: string, line: string, throwOnFail?: boolean): void;
/**
 * Acquire lock → write content to temp file → atomic rename → release.
 * Prevents partial writes on crash. Safe for concurrent full-file writers.
 * Default: fail soft (throwOnFail=false) — logs warning, returns gracefully.
 */
export declare function lockedWrite(filePath: string, content: string, throwOnFail?: boolean): void;
/**
 * Acquire lock → read file → transform content → write to temp → atomic rename → release.
 * Eliminates RMW race conditions. The transform function receives the current file content
 * and must return the new content. If it returns the same content, no write occurs.
 * Default: fail hard (throwOnFail=true) — state mutations are critical.
 */
export declare function lockedReadModifyWrite(filePath: string, transform: (content: string) => string, throwOnFail?: boolean): void;
/**
 * Async version of lockedAppend for use in async pipelines.
 * Default: fail soft (throwOnFail=false).
 */
export declare function lockedAppendAsync(filePath: string, line: string, throwOnFail?: boolean): Promise<void>;
/**
 * Async version of lockedWrite.
 * Default: fail soft (throwOnFail=false).
 */
export declare function lockedWriteAsync(filePath: string, content: string, throwOnFail?: boolean): Promise<void>;
/**
 * Async version of lockedReadModifyWrite for use in async pipelines.
 * Acquires lock → reads file → applies transform → atomic write → releases.
 * Uses LOCK_OPTIONS with 5 retries + exponential backoff (vs sync which has 0 retries).
 * Default: fail hard (throwOnFail=true) — state mutations are critical.
 */
export declare function lockedReadModifyWriteAsync(filePath: string, transform: (content: string) => string, throwOnFail?: boolean): Promise<void>;
