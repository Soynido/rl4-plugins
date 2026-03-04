/**
 * deepMiner.ts — Forensic SQLite recovery from ALL Cursor workspaces.
 *
 * Scans ~/Library/Application Support/Cursor/User/workspaceStorage/*
 * to find orphan chat history from other workspaces, including messages
 * from before RL4 was installed.
 *
 * Uses a 3-level ContextMatcher with Unique Intent Identifiers to filter
 * only messages relevant to the current project.
 */
import type { ChatMessage } from "./scanItemTransformer.js";
export interface OrphanWorkspace {
    id: string;
    folder: string;
    dbPath: string;
    messageCount: number;
    matchScore: number;
    dateRange: {
        from: string;
        to: string;
    };
}
/**
 * Scan ALL workspaceStorage for orphan messages relevant to the current project.
 *
 * @param keywords — keywords to boost relevance scoring
 * @param includeAll — if true, include ALL workspaces regardless of match score
 * @returns orphan workspace info + recovered messages
 */
export declare function scanOrphanWorkspaces(keywords?: string[], includeAll?: boolean): Promise<{
    orphans: OrphanWorkspace[];
    messages: ChatMessage[];
    scannedCount: number;
}>;
/**
 * Scan globalStorage for composer data not tied to any workspace.
 */
export declare function scanGlobalStorage(keywords?: string[]): Promise<{
    messages: ChatMessage[];
    composerCount: number;
}>;
