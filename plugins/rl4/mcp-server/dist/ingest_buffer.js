/**
 * Ingest Buffer — Shared between http_server.ts and search.ts.
 * Extracted to break circular dependency (http_server ↔ search).
 */
const INGEST_BUFFER_MAX = 500;
/**
 * In-memory buffer of recently ingested lines, keyed by file basename.
 * Retained briefly so search.ts can include events before the mtime cache refreshes.
 * Capped at 500 lines per file to bound memory.
 */
const ingestBuffer = new Map();
/** Read the ingest buffer — used by search.ts to merge pending events. */
export function getIngestBuffer() {
    return ingestBuffer;
}
/** Push lines into the ingest buffer — called by http_server.ts on /ingest. */
export function pushToIngestBuffer(file, lines) {
    let buf = ingestBuffer.get(file);
    if (!buf) {
        buf = [];
        ingestBuffer.set(file, buf);
    }
    buf.push(...lines);
    if (buf.length > INGEST_BUFFER_MAX) {
        buf.splice(0, buf.length - INGEST_BUFFER_MAX);
    }
}
