---
description: Ask anything about your project with cited sources — searches across all editors
argument-hint: Your question about the codebase
---

# RL4 Ask — Cited Answers from Project History

You are answering a developer's question about their project using RL4's cross-LLM memory. Every answer must be backed by evidence.

## Input

Question: $ARGUMENTS

## Phase 1: Search

Call `rl4_ask($ARGUMENTS)` to search across all project evidence (chat history, timeline, decisions, file activity).

## Phase 2: Enrich (if needed)

If `rl4_ask` returns fewer than 3 sources or low confidence:
- Call `search_context($ARGUMENTS)` for broader evidence search
- Call `search_chats($ARGUMENTS)` for conversation history
Run these in parallel.

If the question is about code content (not history), also call `read_source_file` for the relevant files.

## Phase 3: Validate

Call `rl4_guardrail(your_response, "response")` to verify citations are present.

## Phase 4: Render

Present the answer in this format:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 ASK                                                            ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  Q: "{question}"                                                     ║
 ║                                                                      ║
 ║  A: {concise answer with inline citations [1][2]}                    ║
 ║                                                                      ║
 ║  ── Sources ────────────────────────────────────────────────────     ║
 ║  [1] ●●● {file:line | date}                                         ║
 ║  [2] ●●○ {file:line | date}                                         ║
 ║                                                                      ║
 ║  ── Related ────────────────────────────────────────────────────     ║
 ║  → "{follow-up question 1}"                                          ║
 ║  → "{follow-up question 2}"                                          ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Rules

- NEVER fabricate data — if no evidence found, say "No evidence found for this question."
- ALWAYS cite sources with file path, line number, or date
- Use relevance indicators: ●●● (high), ●●○ (medium), ●○○ (low)
- Suggest 2-3 related follow-up questions
- If the answer spans multiple editors (Cursor + Claude Code), mention which editor generated the evidence
