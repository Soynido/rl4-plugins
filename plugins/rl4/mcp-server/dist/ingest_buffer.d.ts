/**
 * Ingest Buffer — Shared between http_server.ts and search.ts.
 * Extracted to break circular dependency (http_server ↔ search).
 */
/** Read the ingest buffer — used by search.ts to merge pending events. */
export declare function getIngestBuffer(): ReadonlyMap<string, readonly string[]>;
/** Push lines into the ingest buffer — called by http_server.ts on /ingest. */
export declare function pushToIngestBuffer(file: string, lines: string[]): void;
