/**
 * scanItemTransformer.ts — Shared transformer for chat message normalization.
 *
 * CRITICAL: This is the single source of truth for converting raw ScanItem
 * data (from Cursor SQLite) into the canonical ChatMessage format consumed
 * by search.ts and the RAG engine.
 *
 * Without this transformer, CLI and Extension write incompatible formats
 * to chat_history.jsonl, breaking dedup and search.
 */
export interface ChatMessage {
    id: string;
    thread_id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
    unix_ms: number;
    provider?: string;
}
/**
 * Normalise un ScanItem brut (Cursor SQLite) en ChatMessage canonique.
 *
 * CRITIQUE : L'ID doit être DÉTERMINISTE — même input = même ID.
 * Sans ça, le dédoublonnage par Set<id> dans backfill_chat_history rate les doublons.
 */
export declare function scanItemToChatMessage(item: {
    generationUUID?: string;
    unixMs: number;
    type?: string;
    textDescription?: string;
    provider?: string;
    transcript_ref?: string;
}): ChatMessage;
