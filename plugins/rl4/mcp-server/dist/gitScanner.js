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
import { execFileSync } from "child_process";
import * as path from "path";
/**
 * Discover git repositories in a workspace (root + sub-repos up to maxdepth 3).
 */
// Directories that should never be scanned for git repos (pollution sources)
const REPO_BLACKLIST = ["node_modules", "dist", "out", "build", ".trash", ".cache", "vendor", "__pycache__"];
export function discoverGitRepos(workspaceRoot, maxDepth = 3) {
    const repos = [];
    // Check if workspace root is a git repo
    try {
        execFileSync("git", ["rev-parse", "--git-dir"], { cwd: workspaceRoot, stdio: "pipe" });
        repos.push(workspaceRoot);
    }
    catch { /* not a git repo */ }
    // Find sub-repos (with sanitized exclusions)
    try {
        const findArgs = [
            ".", "-name", ".git", "-type", "d",
            "-maxdepth", String(maxDepth),
            "-not", "-path", "./.git",
        ];
        // Add blacklist exclusions to find command
        for (const dir of REPO_BLACKLIST) {
            findArgs.push("-not", "-path", `*/${dir}/*`);
        }
        const output = execFileSync("find", findArgs, { cwd: workspaceRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).trim();
        if (output) {
            for (const gitDir of output.split("\n")) {
                const repoDir = path.resolve(workspaceRoot, path.dirname(gitDir));
                if (!repos.includes(repoDir)) {
                    repos.push(repoDir);
                }
            }
        }
    }
    catch { /* find failed — just use what we have */ }
    return repos;
}
/**
 * Scan a git repository and return commits as FileEvents + ChatMessages.
 *
 * @param repoPath — absolute path to the git repo
 * @param since — optional ISO date filter (only commits after this date)
 * @returns activities (for activity.jsonl) + chatMessages (for chat_history.jsonl)
 */
export function scanGitHistory(repoPath, since) {
    const activities = [];
    const chatMessages = [];
    const commits = [];
    const args = ["log", "--all", "--reverse", "--format=COMMIT:%H|%aI|%an|%s", "--numstat"];
    if (since) {
        args.push(`--since=${since}`);
    }
    let output;
    try {
        output = execFileSync("git", args, {
            cwd: repoPath,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 30000,
            maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
        });
    }
    catch {
        return { activities, chatMessages, commits };
    }
    const repoName = path.basename(repoPath);
    const lines = output.split("\n");
    let current = null;
    for (const line of lines) {
        if (line.startsWith("COMMIT:")) {
            // Flush previous commit
            if (current) {
                flushCommit(current, repoName, activities, chatMessages, commits);
            }
            // Parse: COMMIT:hash|date|author|message
            const rest = line.slice(7);
            const pipeIdx1 = rest.indexOf("|");
            const pipeIdx2 = rest.indexOf("|", pipeIdx1 + 1);
            const pipeIdx3 = rest.indexOf("|", pipeIdx2 + 1);
            if (pipeIdx1 === -1 || pipeIdx2 === -1 || pipeIdx3 === -1)
                continue;
            current = {
                hash: rest.slice(0, pipeIdx1),
                date: rest.slice(pipeIdx1 + 1, pipeIdx2),
                author: rest.slice(pipeIdx2 + 1, pipeIdx3),
                message: rest.slice(pipeIdx3 + 1),
                files: [],
                repo: repoName,
            };
        }
        else if (current && line.trim()) {
            // --numstat line: "added\tremoved\tfilepath"
            const parts = line.split("\t");
            if (parts.length >= 3) {
                const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
                const removed = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
                current.files.push({
                    path: parts.slice(2).join("\t"), // handle tabs in filenames
                    linesAdded: added,
                    linesRemoved: removed,
                });
            }
        }
    }
    // Flush last commit
    if (current) {
        flushCommit(current, repoName, activities, chatMessages, commits);
    }
    return { activities, chatMessages, commits };
}
function flushCommit(commit, repoName, activities, chatMessages, commits) {
    commits.push(commit);
    const commitDate = new Date(commit.date);
    const unix_ms = commitDate.getTime();
    const timestamp = commitDate.toISOString();
    // One FileEvent per file modified
    for (const file of commit.files) {
        activities.push({
            kind: "git_commit",
            source: "git_commit",
            file: `${repoName}/${file.path}`,
            timestamp,
            unix_ms,
            linesAdded: file.linesAdded,
            linesRemoved: file.linesRemoved,
            repo: repoName,
            commit_hash: commit.hash,
            commit_message: commit.message,
        });
    }
    // One ChatMessage per commit = "Ghost Prompt" (retroactive intent)
    chatMessages.push({
        id: `git-${commit.hash}`,
        thread_id: `git-${repoName}`,
        role: "user",
        content: `[git commit ${commit.hash.slice(0, 8)}] ${commit.message}`,
        timestamp,
        unix_ms,
        provider: "git",
    });
}
