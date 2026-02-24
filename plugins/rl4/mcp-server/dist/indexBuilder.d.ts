import { type IndexedChunk } from "./chunking.js";
export interface MetadataIndex {
    chunks: IndexedChunk[];
    builtAt: string;
    root: string;
}
/** Expose signature for engine cache invalidation in rag.ts */
export declare function getIndexSignature(root: string): string;
export declare function buildMetadataIndex(root: string): MetadataIndex;
/** Pre-filter chunks by metadata (date, tag, source, file) */
export declare function filterChunks(chunks: IndexedChunk[], filters: {
    date_from?: string;
    date_to?: string;
    tag?: string;
    source?: IndexedChunk["metadata"]["source"];
    file?: string;
}): IndexedChunk[];
