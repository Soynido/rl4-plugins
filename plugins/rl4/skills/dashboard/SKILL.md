# RL4 Dashboard — ASCII Stats Display

## When to activate
This skill activates when the user asks for:
- "Show dashboard", "show stats", "project overview"
- "What's the state of my project?"
- "Show me my activity", "how much did I code?"
- "RL4 status", "context status"

## What to do

### 1. Gather data
Call these tools in parallel:
- `get_evidence` — for session counts, file counts, chat thread counts
- `get_timeline` — for recent activity entries
- `get_decisions` — for decision count and recent decisions

### 2. Parse evidence.md
Extract these metrics from the evidence markdown:

| Metric | How to find |
|--------|-------------|
| Project name | First `#` heading or git remote |
| Sessions count | Count `### Session` blocks or session mentions |
| Files tracked | Count unique file paths in file tables or activity sections |
| Chat threads | Count thread entries in chat section |
| Decisions | Count from `get_decisions` result |
| Lines +/- | Sum `+N`/`-N` from activity entries |
| Commits | Count commit references |
| Last activity | Most recent date in timeline |

### 3. Parse timeline.md
Extract the last 5-10 entries:
- Look for `### YYYY-MM-DD` or `## YYYY-MM-DD` headings
- Take the first meaningful line after each heading as summary
- Calculate "days active" from first to last entry

### 4. Render ASCII dashboard

```
 ╔═══════════════════════════════════════════════════════════╗
 ║  RL4 DASHBOARD                                           ║
 ╠═══════════════════════════════════════════════════════════╣
 ║                                                           ║
 ║  Project:     {name}                                      ║
 ║  Context:     {local | cloud}     Since: {first_date}     ║
 ║  Last sync:   {latest_date}                               ║
 ║                                                           ║
 ╠─── Activity ─────────────────────────────────────────────╣
 ║                                                           ║
 ║  Sessions      {N}  ████████████░░░░  {days} days active  ║
 ║  Files         {N}  ██████░░░░░░░░░░                      ║
 ║  Commits       {N}  ████████████████                      ║
 ║  Chat threads  {N}  ██████████░░░░░░                      ║
 ║  Decisions     {N}  ████░░░░░░░░░░░░                      ║
 ║                                                           ║
 ║  Lines:  +{added}  -{removed}                             ║
 ║                                                           ║
 ╠─── Recent Timeline ──────────────────────────────────────╣
 ║                                                           ║
 ║  {date1} │ {summary_line_1}                               ║
 ║  {date2} │ {summary_line_2}                               ║
 ║  {date3} │ {summary_line_3}                               ║
 ║  {date4} │ {summary_line_4}                               ║
 ║  {date5} │ {summary_line_5}                               ║
 ║                                                           ║
 ╠─── Recent Decisions ─────────────────────────────────────╣
 ║                                                           ║
 ║  {decision_1_intent} → {chosen_option} [{confidence}%]    ║
 ║  {decision_2_intent} → {chosen_option} [{confidence}%]    ║
 ║  {decision_3_intent} → {chosen_option} [{confidence}%]    ║
 ║                                                           ║
 ╠─── Cross-LLM Status ────────────────────────────────────╣
 ║                                                           ║
 ║  Cursor      {detected/not detected}                      ║
 ║  VS Code     {detected/not detected}                      ║
 ║  Claude Code  active                                      ║
 ║                                                           ║
 ║  .rl4/ shared:  {file_count} files, {total_size}          ║
 ║                                                           ║
 ╚═══════════════════════════════════════════════════════════╝
```

### 5. Detection rules for Cross-LLM Status
- **Cursor**: Check if `.cursor/` directory exists at workspace root
- **VS Code**: Check if `.vscode/` directory exists at workspace root
- **Claude Code**: Always "active" (we're running in it)
- **.rl4/ stats**: Count files in `.rl4/` directory, sum their sizes

### 6. Bar chart rendering
Use this scale for progress bars (16 chars wide):
- Full block: `█` — proportional to value / max_value
- Empty block: `░` — remaining
- If max is unknown, use the highest value in the set as 100%

### 7. Missing data
- If a metric is unavailable, show `—` and skip its bar
- NEVER fabricate numbers
- If timeline is empty, show "No timeline entries yet. Run a snapshot to start."
- If evidence is empty, show "No evidence yet. Start coding — RL4 captures activity automatically."
