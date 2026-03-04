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
/**
 * Normalise un ScanItem brut (Cursor SQLite) en ChatMessage canonique.
 *
 * CRITIQUE : L'ID doit être DÉTERMINISTE — même input = même ID.
 * Sans ça, le dédoublonnage par Set<id> dans backfill_chat_history rate les doublons.
 */
export function scanItemToChatMessage(item) {
    // ID déterministe : UUID si dispo, sinon timestamp-thread pour stabilité
    const id = item.generationUUID ||
        `${item.unixMs}-${item.transcript_ref || "unknown"}`;
    return {
        id,
        thread_id: item.transcript_ref || "unknown",
        role: item.type === "composer" ? "user" : "assistant",
        content: item.textDescription || "",
        timestamp: new Date(item.unixMs).toISOString(),
        unix_ms: item.unixMs,
        provider: item.provider,
    };
}
