/**
 * gitScanner.ts — Git-to-Evidence bridge.
 *
 * Scans git repositories and transforms commit history into RL4 evidence:
 * - FileEvents (activity.jsonl) with linesAdded/linesRemoved for Hot Score
 * - ChatMessages (chat_history.jsonl) as "Ghost Prompts" — commit messages as retroactive intent
 *
 * Reuses patterns from:
 * - InitialCapture.ts:seedFromGitLog() (git log parsing)
 * - GitCommitListener.ts:saveCommit() (SWA-compliant writes)
 *
 * SWA: This module lives in the MCP daemon process → uses lockedAppendAsync() directly.
 */
import type { ChatMessage } from "./scanItemTransformer.js";
export interface GitCommitEvent {
    hash: string;
    date: string;
    author: string;
    message: string;
    files: {
        path: string;
        linesAdded: number;
        linesRemoved: number;
    }[];
    repo: string;
}
export interface FileEvent {
    kind: string;
    source: string;
    file: string;
    timestamp: string;
    unix_ms: number;
    linesAdded?: number;
    linesRemoved?: number;
    repo?: string;
    commit_hash?: string;
    commit_message?: string;
}
export declare function discoverGitRepos(workspaceRoot: string, maxDepth?: number): string[];
/**
 * Scan a git repository and return commits as FileEvents + ChatMessages.
 *
 * @param repoPath — absolute path to the git repo
 * @param since — optional ISO date filter (only commits after this date)
 * @returns activities (for activity.jsonl) + chatMessages (for chat_history.jsonl)
 */
export declare function scanGitHistory(repoPath: string, since?: string): {
    activities: FileEvent[];
    chatMessages: ChatMessage[];
    commits: GitCommitEvent[];
};
