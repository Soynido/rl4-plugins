/**
 * RL4 HTTP Gatekeeper Server — v1.4 (Single-Writer Architecture)
 *
 * Runs in-process with the MCP server (shared caches, zero overhead).
 * Provides /validate (write-path), /enrich (read-path), /ingest (single-writer),
 * and /ingest-threads (thread upsert) endpoints.
 *
 * Single-Writer: The MCP daemon is the ONLY process that writes to .rl4/evidence/.
 * Extension + hooks POST events to /ingest; the server serializes all writes
 * through lockedAppend — eliminating cross-process corruption.
 *
 * Bind: 127.0.0.1 only (localhost, no network exposure).
 * Port: 17340 (default, configurable via RL4_HTTP_PORT).
 * Transport: Node.js built-in http module (zero deps).
 */
import * as http from "http";
export { getIngestBuffer } from "./ingest_buffer.js";
/**
 * Match content against AVOID patterns using keyword overlap.
 * Returns the list of violated patterns (those where ≥50% of significant keywords match).
 * Exported for use by audit_refactor MCP tool.
 */
export declare function matchAvoidPatterns(content: string, avoidPatterns: string[]): string[];
export declare function handleContextForPrompt(root: string, prompt: string): {
    context: string;
    sources_count: number;
};
export declare function startHttpServer(root: string, opts?: {
    port?: number;
}): http.Server;
