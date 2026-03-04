---
description: Resume your work — what you did last, hot files, and next steps
---

# RL4 Resume — Pick Up Where You Left Off

You are helping a developer resume their work. RL4 tracks everything across all editors (Cursor, VS Code, Claude Code). Use this cross-LLM memory to give a perfect "what happened and what's next" briefing.

## Phase 1: Gather Recent Context

Run all in parallel:

1. Call `get_timeline()` to get the full project timeline — focus on the most recent entries.

2. Call `get_evidence()` to get project-level stats (sessions, files, threads).

3. Call `get_intent_graph()` to get hot files with activity scores and trajectories.

4. Call `search_context("latest activity")` to find the most recent context entries.

## Phase 2: Render Resume Briefing

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 RESUME — Pick Up Where You Left Off                            ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  LAST SESSION  {date} {time} ({editor})  Duration: {duration}       ║
 ║  EDITORS USED  Cursor {✓|○}  Claude Code {✓|○}  VS Code {✓|○}     ║
 ║                                                                      ║
 ║  ── What you were doing ────────────────────────────────────────    ║
 ║  • {recent activity 1}                                               ║
 ║  • {recent activity 2}                                               ║
 ║  • {recent activity 3}                                               ║
 ║  • Stopped at: {last known state}                                    ║
 ║                                                                      ║
 ║  ── Hot Files (by activity) ────────────────────────────────────    ║
 ║  {████████████████████}  {file}  score: {N} {↑↑|↑|→|↓}             ║
 ║  {████████████░░░░░░░░}  {file}  score: {N} {↑↑|↑|→|↓}             ║
 ║  {████████░░░░░░░░░░░░}  {file}  score: {N} {↑↑|↑|→|↓}             ║
 ║                                                                      ║
 ║  ── Suggested Next Steps ───────────────────────────────────────    ║
 ║  1. {most logical next action}                                       ║
 ║  2. {second priority}                                                ║
 ║  3. {third priority}                                                 ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Parsing Rules

- **Last session**: Extract from the most recent timeline/evidence entry. Include which editor was used.
- **Editors used**: Check evidence for Cursor DB entries, Claude Code JSONL, and VS Code markers.
- **Hot files**: From intent_graph chains, sorted by hot_score descending. Show top 4.
- **Progress bars**: 20 chars wide. `█` proportional to score (0-1), `░` for remainder.
- **Trajectory arrows**: `↑↑` = accelerating, `↑` = growing, `→` = stable, `↓` = declining.
- **Next steps**: Infer from incomplete work, open TODOs in timeline, and hot file trajectories.

## Rules

- Focus on what the developer was DOING, not just what files changed
- Always mention which editors contributed context (cross-LLM is the selling point)
- Suggest concrete next steps, not vague advice
