#!/usr/bin/env node
/**
 * RL4 CLI — Standalone entry point for context-for-prompt.
 *
 * Used by rl4-prompt-capture.sh as fallback when the Cursor HTTP daemon
 * (port 17340) is not running. Provides the same 6-part context
 * (file-specific + AVOID + RAG + hot files + decisions + timeline)
 * without requiring the HTTP server.
 *
 * Usage:
 *   node cli.js context-for-prompt <workspace_root> [prompt_text]
 *
 * Read-only — respects SWA (no writes to .rl4/evidence/).
 */
export {};
