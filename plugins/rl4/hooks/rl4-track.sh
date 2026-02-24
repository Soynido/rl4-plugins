#!/usr/bin/env bash
# RL4 PostToolUse hook — captures file modifications into .rl4/evidence/activity.jsonl
# Same format as the Cursor/VS Code IDE extension FS watcher.
# Works with Edit, Write, and Bash (for git/mv/cp file ops).
#
# Stdin: JSON with tool_name, tool_input, tool_response, cwd
# Stdout: nothing (hook is passive — never blocks)
# Exit 0 always (never interfere with Claude Code flow)

set -euo pipefail

# Read full stdin JSON
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Only process Edit and Write tools
case "$TOOL_NAME" in
  Edit|Write) ;;
  *) exit 0 ;;
esac

# Extract file path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve absolute path
if [[ "$FILE_PATH" != /* ]]; then
  FILE_PATH="$CWD/$FILE_PATH"
fi

# File must exist (Write creates, Edit modifies — both should exist after PostToolUse)
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Find .rl4 directory — walk up from CWD
RL4_DIR=""
SEARCH_DIR="$CWD"
while [ "$SEARCH_DIR" != "/" ]; do
  if [ -d "$SEARCH_DIR/.rl4" ]; then
    RL4_DIR="$SEARCH_DIR/.rl4"
    WORKSPACE_ROOT="$SEARCH_DIR"
    break
  fi
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

# No .rl4 directory found — create it
if [ -z "$RL4_DIR" ]; then
  RL4_DIR="$CWD/.rl4"
  WORKSPACE_ROOT="$CWD"
  mkdir -p "$RL4_DIR/evidence"
fi

# Ensure evidence directory exists
EVIDENCE_DIR="$RL4_DIR/evidence"
mkdir -p "$EVIDENCE_DIR"

# Compute relative path from workspace root
REL_PATH="${FILE_PATH#$WORKSPACE_ROOT/}"

# Compute SHA-256 of the file
SHA256=$(shasum -a 256 "$FILE_PATH" 2>/dev/null | cut -d' ' -f1 || echo "")

# Compute lines added/removed for Edit tool
LINES_ADDED=0
LINES_REMOVED=0

if [ "$TOOL_NAME" = "Edit" ]; then
  # For Edit: count lines in old_string / new_string
  # Use jq to safely extract and count (handles embedded newlines)
  LINES_REMOVED=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""' | wc -l | tr -d ' ')
  LINES_ADDED=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""' | wc -l | tr -d ' ')
elif [ "$TOOL_NAME" = "Write" ]; then
  # For Write: count lines in the actual file (avoids parsing huge content from stdin)
  LINES_ADDED=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
  LINES_ADDED=${LINES_ADDED:-0}
fi

# Determine kind: save for Edit, create for Write (simplified — Write could be overwrite)
KIND="save"
if [ "$TOOL_NAME" = "Write" ]; then
  KIND="save"
fi

# Generate ISO timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Session ID from stdin (reuse as burst_id prefix)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' | head -c 12)
BURST_ID="burst-cli-${SESSION_ID:-unknown}"

# Build the activity entry — same format as IDE (compact single-line JSON)
ENTRY=$(jq -cn \
  --arg t "$TIMESTAMP" \
  --arg kind "$KIND" \
  --arg path "$REL_PATH" \
  --arg sha256 "$SHA256" \
  --arg burst_id "$BURST_ID" \
  --argjson linesAdded "$LINES_ADDED" \
  --argjson linesRemoved "$LINES_REMOVED" \
  --arg persisted_at "$TIMESTAMP" \
  --arg source "claude-code" \
  '{t: $t, kind: $kind, path: $path, sha256: $sha256, burst_id: $burst_id, linesAdded: $linesAdded, linesRemoved: $linesRemoved, persisted_at: $persisted_at, source: $source}')

# Append atomically (>> is atomic for small writes on most filesystems)
echo "$ENTRY" >> "$EVIDENCE_DIR/activity.jsonl"

# --- ContentStore: save file blob (same format as IDE) ---
if [ -n "$SHA256" ]; then
  SNAPSHOTS_DIR="$RL4_DIR/snapshots"
  mkdir -p "$SNAPSHOTS_DIR"
  BLOB_PATH="$SNAPSHOTS_DIR/${SHA256}.content.gz"

  # Only write if blob doesn't already exist (content-addressed = dedup)
  if [ ! -f "$BLOB_PATH" ]; then
    gzip -c "$FILE_PATH" > "$BLOB_PATH" 2>/dev/null || true
  fi

  # Update file_index.json (path → [checksum1, checksum2, ...])
  INDEX_PATH="$SNAPSHOTS_DIR/file_index.json"
  if [ -f "$INDEX_PATH" ]; then
    # Add checksum to array for this path (dedup)
    python3 -c "
import json, sys
idx = json.load(open('$INDEX_PATH'))
path = '$REL_PATH'
sha = '$SHA256'
arr = idx.get(path, [])
if isinstance(arr, str): arr = [arr]
if sha not in arr: arr.append(sha)
idx[path] = arr
json.dump(idx, open('$INDEX_PATH', 'w'), separators=(',', ':'))
" 2>/dev/null || true
  else
    # Create new file_index.json
    echo "{\"$REL_PATH\":[\"$SHA256\"]}" > "$INDEX_PATH"
  fi
fi

exit 0
