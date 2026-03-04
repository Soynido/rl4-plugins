/**
 * SafeDiskWriter — Cross-process file locking for .rl4/evidence/*.jsonl
 *
 * Uses proper-lockfile for OS-level advisory locks with stale detection.
 * All writes go through temp-file + atomic rename to prevent partial writes.
 *
 * Lock convention: ${filePath}.lock (proper-lockfile default)
 * Both MCP server and IDE extension use the same lock convention for interop.
 *
 * Error policy (throwOnFail):
 *   - lockedAppend / lockedWrite: default false — fail soft, log warning, never crash caller
 *   - lockedReadModifyWrite: default true — state mutations are critical, caller must know
 */
import * as fs from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";
// ── Lock Configuration ─────────────────────────────────────────────────────
/** Async lock options — retries supported by lockfile.lock() */
const LOCK_OPTIONS = {
    stale: 10000, // 10s — auto-release stale locks (crashed process)
    retries: {
        retries: 5,
        minTimeout: 100,
        maxTimeout: 3200, // 100ms * 2^5
        factor: 2,
    },
};
/** Sync lock options — lockfile.lockSync() does NOT support retries */
const LOCK_OPTIONS_SYNC = {
    stale: 10000,
};
// ── Logging ────────────────────────────────────────────────────────────────
function logLockFailure(filePath, error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[RL4 Lock Timeout] Failed to write to ${filePath}: ${msg}`);
}
// ── Directory Safety ───────────────────────────────────────────────────────
/**
 * Idempotent mkdir — catches EEXIST from concurrent creators.
 */
export function ensureDirSync(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
    }
}
/**
 * Ensure the target file exists (proper-lockfile requires it).
 * Creates parent dirs + empty file if missing.
 */
function ensureFileExists(filePath) {
    ensureDirSync(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
        try {
            fs.writeFileSync(filePath, "", { flag: "wx" }); // wx = create exclusive
        }
        catch (e) {
            // EEXIST is fine — another process created it between our check and write
            if (e.code !== "EEXIST")
                throw e;
        }
    }
}
// ── Locked Primitives ──────────────────────────────────────────────────────
/**
 * Acquire lock → append line (with trailing \n) → release.
 * Safe for concurrent appenders across processes.
 * Default: fail soft (throwOnFail=false) — logs warning, returns gracefully.
 */
export function lockedAppend(filePath, line, throwOnFail = false) {
    ensureFileExists(filePath);
    let release;
    try {
        release = lockfile.lockSync(filePath, LOCK_OPTIONS_SYNC);
        fs.appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n");
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            release();
    }
}
/**
 * Acquire lock → write content to temp file → atomic rename → release.
 * Prevents partial writes on crash. Safe for concurrent full-file writers.
 * Default: fail soft (throwOnFail=false) — logs warning, returns gracefully.
 */
export function lockedWrite(filePath, content, throwOnFail = false) {
    ensureFileExists(filePath);
    let release;
    try {
        release = lockfile.lockSync(filePath, LOCK_OPTIONS_SYNC);
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, filePath);
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            release();
    }
}
/**
 * Acquire lock → read file → transform content → write to temp → atomic rename → release.
 * Eliminates RMW race conditions. The transform function receives the current file content
 * and must return the new content. If it returns the same content, no write occurs.
 * Default: fail hard (throwOnFail=true) — state mutations are critical.
 */
export function lockedReadModifyWrite(filePath, transform, throwOnFail = true) {
    ensureFileExists(filePath);
    let release;
    try {
        release = lockfile.lockSync(filePath, LOCK_OPTIONS_SYNC);
        const content = fs.readFileSync(filePath, "utf8");
        const result = transform(content);
        if (result === content)
            return; // No change — skip write
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, result);
        fs.renameSync(tmp, filePath);
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            release();
    }
}
// ── Async Variants (for extension-side AppendOnlyJsonl) ────────────────────
/**
 * Async version of lockedAppend for use in async pipelines.
 * Default: fail soft (throwOnFail=false).
 */
export async function lockedAppendAsync(filePath, line, throwOnFail = false) {
    ensureFileExists(filePath);
    let release;
    try {
        release = await lockfile.lock(filePath, LOCK_OPTIONS);
        await fs.promises.appendFile(filePath, line.endsWith("\n") ? line : line + "\n");
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            await release();
    }
}
/**
 * Async version of lockedWrite.
 * Default: fail soft (throwOnFail=false).
 */
export async function lockedWriteAsync(filePath, content, throwOnFail = false) {
    ensureFileExists(filePath);
    let release;
    try {
        release = await lockfile.lock(filePath, LOCK_OPTIONS);
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmp, content);
        await fs.promises.rename(tmp, filePath);
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            await release();
    }
}
/**
 * Async version of lockedReadModifyWrite for use in async pipelines.
 * Acquires lock → reads file → applies transform → atomic write → releases.
 * Uses LOCK_OPTIONS with 5 retries + exponential backoff (vs sync which has 0 retries).
 * Default: fail hard (throwOnFail=true) — state mutations are critical.
 */
export async function lockedReadModifyWriteAsync(filePath, transform, throwOnFail = true) {
    ensureFileExists(filePath);
    let release;
    try {
        release = await lockfile.lock(filePath, LOCK_OPTIONS);
        const content = await fs.promises.readFile(filePath, "utf8");
        const result = transform(content);
        if (result === content)
            return; // No change — skip write
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmp, result);
        await fs.promises.rename(tmp, filePath);
    }
    catch (e) {
        if (throwOnFail)
            throw e;
        logLockFailure(filePath, e);
        return;
    }
    finally {
        if (release)
            await release();
    }
}
