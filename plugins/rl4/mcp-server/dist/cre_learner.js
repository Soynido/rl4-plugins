/**
 * CRE Learner — Intervention logging, outcome resolution, Beta-Binomial update,
 * deterministic replay, and safety guardrails.
 *
 * Source of truth: cre_interventions.jsonl (append-only).
 * Derived state: cre_state.json (replayable from logs).
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { resolveUnderRoot } from "./safePath.js";
import { createEmptyCREState, CRE_PARAMS, } from "./causal_engine.js";
import { readFileSafe, readRecentBursts, getLastActivityTimestamp, loadCREState, saveCREState, } from "./workspace.js";
// ── Hyperparameters ──────────────────────────────────────────────────────────
const REVERSAL_HORIZON = 5; // events
const REWORK_WINDOW = 60; // minutes
const ACCEPTED_NO_TOUCH = 60; // minutes
const INDETERMINATE_TIMEOUT = 120; // minutes
const SESSION_GAP = 20; // minutes
const SAFETY_WINDOW_DAYS = 7;
const SAFETY_THRESHOLD = 0.15; // 15pp increase
// ── Monotonic counter for unique IDs ─────────────────────────────────────────
let interventionCounter = 0;
// ── Intervention Logging ─────────────────────────────────────────────────────
export function logIntervention(root, file, selection, burstId = null) {
    // Integrity guard: never log empty interventions — nothing to learn from
    if (selection.selected.length === 0)
        return null;
    const timestamp = new Date().toISOString();
    const nonce = String(++interventionCounter);
    const id = `cre-${crypto.createHash("sha256")
        .update(`${file}|${timestamp}|${nonce}`)
        .digest("hex").slice(0, 8)}`;
    // V1.1: Compute normalized propensity π_log for SWITCH-DR
    const allScores = [...selection.selected, ...selection.candidates].map(s => s.crs_score);
    const scoreSum = allScores.reduce((a, b) => a + b, 0);
    const piLog = scoreSum > 0
        ? selection.selected.map(s => s.crs_score / scoreSum)
        : selection.selected.map(() => 1 / Math.max(1, selection.selected.length));
    const intervention = {
        intervention_id: id,
        cre_version: "1.1.0",
        timestamp,
        file,
        burst_id: burstId,
        selected_lessons: selection.selected,
        candidate_lessons: selection.candidates,
        budget_tokens: selection.budget_tokens,
        used_tokens: selection.used_tokens,
        outcome: "pending",
        outcome_resolved_at: null,
        outcome_signals: null,
        pi_log: piLog,
    };
    const logPath = getInterventionLogPath(root);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(intervention) + "\n");
    return id;
}
// ── Outcome Resolution ───────────────────────────────────────────────────────
/**
 * Resolve pending interventions for a given file.
 * Called on file save, burst flush, and commit detection.
 */
export function resolveOutcomes(root, files) {
    const logPath = getInterventionLogPath(root);
    const raw = readFileSafe(logPath);
    if (!raw)
        return;
    const lines = raw.trim().split("\n").filter(Boolean);
    let changed = false;
    const updated = lines.map(line => {
        try {
            const intervention = JSON.parse(line);
            if (intervention.outcome !== "pending")
                return line;
            if (!files.includes(intervention.file))
                return line;
            const resolved = tryResolve(root, intervention);
            if (resolved) {
                changed = true;
                return JSON.stringify(resolved);
            }
            return line;
        }
        catch {
            return line;
        }
    });
    if (changed) {
        fs.writeFileSync(logPath, updated.join("\n") + "\n");
        // Update CRE state for resolved interventions
        for (const line of updated) {
            try {
                const intervention = JSON.parse(line);
                if (intervention.outcome !== "pending" && intervention.outcome !== "indeterminate"
                    && intervention.outcome_resolved_at) {
                    updateCREStateFromIntervention(root, intervention);
                }
            }
            catch { /* skip */ }
        }
    }
}
function tryResolve(root, intervention) {
    const now = Date.now();
    const elapsed = now - new Date(intervention.timestamp).getTime();
    const minutes = elapsed / 60000;
    const noTouch = noTouchMinutes(root, intervention.file, intervention.timestamp);
    const committed = wasCommitted(root, intervention.file, intervention.timestamp);
    // Priority 1: reversed_fast
    if (detectReversalSince(root, intervention.file, intervention.timestamp, REVERSAL_HORIZON)) {
        return resolveWith(intervention, "reversed_fast", committed, noTouch);
    }
    // Priority 2: reworked
    if (detectSignificantRework(root, intervention.file, intervention.timestamp)) {
        return resolveWith(intervention, "reworked", committed, noTouch);
    }
    // Priority 3: accepted
    if (noTouch >= ACCEPTED_NO_TOUCH
        || sessionEndedStably(root, intervention.file, intervention.timestamp)
        || (committed && noTouch >= 15)) {
        return resolveWith(intervention, "accepted", committed, noTouch);
    }
    // Timeout: indeterminate
    if (minutes > INDETERMINATE_TIMEOUT) {
        return resolveWith(intervention, "indeterminate", committed, noTouch);
    }
    return null; // still pending
}
function resolveWith(intervention, outcome, committed, noTouch) {
    return {
        ...intervention,
        outcome,
        outcome_resolved_at: new Date().toISOString(),
        outcome_signals: {
            reversed_fast: outcome === "reversed_fast",
            reworked: outcome === "reworked",
            committed,
            no_touch_minutes: noTouch,
            burst_pattern: null,
        },
    };
}
// ── Outcome Detection Helpers ────────────────────────────────────────────────
function noTouchMinutes(root, file, sinceTimestamp) {
    var _a;
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const raw = readFileSafe(activityPath);
    if (!raw)
        return 0;
    const sinceMs = new Date(sinceTimestamp).getTime();
    const lines = raw.trim().split("\n").filter(Boolean);
    let lastTouch = sinceMs;
    for (const line of lines) {
        try {
            const ev = JSON.parse(line);
            if (ev.kind !== "save")
                continue;
            if (ev.path !== file && !((_a = ev.path) === null || _a === void 0 ? void 0 : _a.endsWith("/" + file)))
                continue;
            const t = new Date(ev.t).getTime();
            if (t > sinceMs && t > lastTouch)
                lastTouch = t;
        }
        catch { /* skip */ }
    }
    return (Date.now() - lastTouch) / 60000;
}
function detectReversalSince(root, file, sinceTimestamp, horizon) {
    var _a;
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const raw = readFileSafe(activityPath);
    if (!raw)
        return false;
    const sinceMs = new Date(sinceTimestamp).getTime();
    const lines = raw.trim().split("\n").filter(Boolean);
    // Collect file events after sinceTimestamp
    const hashes = [];
    for (const line of lines) {
        try {
            const ev = JSON.parse(line);
            if (ev.kind !== "save")
                continue;
            if (ev.path !== file && !((_a = ev.path) === null || _a === void 0 ? void 0 : _a.endsWith("/" + file)))
                continue;
            if (new Date(ev.t).getTime() <= sinceMs)
                continue;
            if (ev.sha256)
                hashes.push(ev.sha256);
            if (hashes.length >= horizon)
                break;
        }
        catch { /* skip */ }
    }
    // A reversal = same hash appearing twice within the horizon (content went back)
    const seen = new Set();
    for (const h of hashes) {
        if (seen.has(h))
            return true;
        seen.add(h);
    }
    return false;
}
function detectSignificantRework(root, file, sinceTimestamp) {
    var _a, _b, _c;
    const activityPath = resolveUnderRoot(root, ".rl4", "evidence", "activity.jsonl");
    const raw = readFileSafe(activityPath);
    if (!raw)
        return false;
    const sinceMs = new Date(sinceTimestamp).getTime();
    const windowMs = REWORK_WINDOW * 60000;
    const lines = raw.trim().split("\n").filter(Boolean);
    let totalDelta = 0;
    let fileLineCount = 0;
    for (const line of lines) {
        try {
            const ev = JSON.parse(line);
            if (ev.kind !== "save")
                continue;
            if (ev.path !== file && !((_a = ev.path) === null || _a === void 0 ? void 0 : _a.endsWith("/" + file)))
                continue;
            const t = new Date(ev.t).getTime();
            if (t <= sinceMs || t > sinceMs + windowMs)
                continue;
            const added = (_b = ev.linesAdded) !== null && _b !== void 0 ? _b : 0;
            const removed = (_c = ev.linesRemoved) !== null && _c !== void 0 ? _c : 0;
            totalDelta += added + removed;
            fileLineCount = Math.max(fileLineCount, added); // rough proxy
        }
        catch { /* skip */ }
    }
    // Significant rework: abs_delta >= 50 OR abs_delta >= 0.15 × file_line_count
    return totalDelta >= 50 || (fileLineCount > 0 && totalDelta >= 0.15 * fileLineCount);
}
function sessionEndedStably(root, file, interventionTimestamp) {
    const lastActivity = getLastActivityTimestamp(root);
    if (!lastActivity)
        return false;
    const gapMs = Date.now() - new Date(lastActivity).getTime();
    if (gapMs < SESSION_GAP * 60000)
        return false;
    // No rework between intervention and session end
    return !detectSignificantRework(root, file, interventionTimestamp);
}
function wasCommitted(root, file, sinceTimestamp) {
    // Check if file appears in any git commit since timestamp
    // Simple heuristic: check git log (if available)
    try {
        const gitDir = path.join(root, ".git");
        if (!fs.existsSync(gitDir))
            return false;
        // Read from sessions.jsonl for commit events (if logged by GitCommitListener)
        const sessionsPath = resolveUnderRoot(root, ".rl4", "evidence", "sessions.jsonl");
        const raw = readFileSafe(sessionsPath);
        if (!raw)
            return false;
        const sinceMs = new Date(sinceTimestamp).getTime();
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const ev = JSON.parse(line);
                if (ev.event === "commit" && new Date(ev.timestamp || ev.t).getTime() > sinceMs) {
                    const commitFiles = ev.files || [];
                    if (commitFiles.some(f => f === file || f.endsWith("/" + file)))
                        return true;
                }
            }
            catch { /* skip */ }
        }
    }
    catch { /* skip */ }
    return false;
}
// ── CRE State Update ─────────────────────────────────────────────────────────
function updateCREStateFromIntervention(root, intervention) {
    let state = loadCREState(root);
    if (!state)
        state = createEmptyCREState();
    // Integrity guard: skip empty treatment arms
    if (intervention.selected_lessons.length === 0)
        return;
    // Skip if refactor storm
    if (isRefactorStorm(root))
        return;
    // Skip indeterminate
    if (intervention.outcome === "indeterminate" || intervention.outcome === "pending")
        return;
    const isFail = intervention.outcome === "reversed_fast";
    const isSoftFail = intervention.outcome === "reworked";
    const isOk = intervention.outcome === "accepted";
    // Update treatment arm
    for (const sl of intervention.selected_lessons) {
        const ls = getOrCreateLesson(state, sl.id, sl.type);
        if (isFail)
            ls.injected_fail++;
        else if (isSoftFail)
            ls.injected_soft_fail++;
        else if (isOk) {
            ls.injected_ok++;
            ls.triggers++;
            ls.last_triggered = intervention.timestamp;
        }
    }
    // Update control arm — same density bucket (±1 if sparse)
    const selectedBuckets = new Set(intervention.selected_lessons.map(sl => sl.density_bucket));
    for (const cl of intervention.candidate_lessons) {
        if (selectedBuckets.has(cl.density_bucket)) {
            updateBaseline(state, cl.id, cl.type, isFail, isSoftFail, isOk);
        }
        else if (bucketNeighborMatch(cl.density_bucket, selectedBuckets)
            && bucketObservations(state, cl.id) < CRE_PARAMS.BUCKET_MIN_OBS) {
            updateBaseline(state, cl.id, cl.type, isFail, isSoftFail, isOk);
        }
    }
    // Safety update
    state.safety.total_interventions++;
    if (isFail)
        state.safety.total_reversed_fast++;
    if (isSoftFail)
        state.safety.total_reworked++;
    // Update bypass_rate KPI (Manifesto #8)
    state.kpis.bypass_rate = computeBypassRate(root, state.safety.total_interventions);
    checkSafety(state, root);
    state.last_updated = new Date().toISOString();
    saveCREState(root, state);
}
function updateBaseline(state, id, type, isFail, isSoftFail, isOk) {
    const ls = getOrCreateLesson(state, id, type);
    if (isFail)
        ls.baseline_fail++;
    else if (isSoftFail)
        ls.baseline_soft_fail++;
    else if (isOk)
        ls.baseline_ok++;
}
function getOrCreateLesson(state, id, type) {
    if (!state.lessons[id]) {
        state.lessons[id] = {
            injected_ok: 0,
            injected_fail: 0,
            injected_soft_fail: 0,
            baseline_ok: 0,
            baseline_fail: 0,
            baseline_soft_fail: 0,
            triggers: 0,
            last_triggered: "",
            first_seen: new Date().toISOString(),
            type,
        };
    }
    return state.lessons[id];
}
function bucketNeighborMatch(candidateBucket, selectedBuckets) {
    return selectedBuckets.has(candidateBucket - 1) || selectedBuckets.has(candidateBucket + 1);
}
function bucketObservations(state, lessonId) {
    const ls = state.lessons[lessonId];
    if (!ls)
        return 0;
    return ls.baseline_ok + ls.baseline_fail + ls.baseline_soft_fail;
}
// ── Safety Guardrails ────────────────────────────────────────────────────────
function checkSafety(state, root) {
    if (state.safety.total_interventions < 10)
        return; // too early
    const currentRate = state.safety.total_interventions > 0
        ? state.safety.total_reversed_fast / state.safety.total_interventions
        : 0;
    // Compute windowed rates from intervention log
    const { windowA, windowB } = computeWindowedRates(root);
    state.safety.reversal_rate_window_a = windowA;
    state.safety.reversal_rate_window_b = windowB;
    // Sustained regression: window_a > window_b + threshold for 2 consecutive windows
    if (windowA > windowB + SAFETY_THRESHOLD && windowB > 0) {
        if (!state.safety.frozen) {
            state.safety.frozen = true;
            state.safety.frozen_reason = `Sustained regression: window_a=${windowA.toFixed(3)} > window_b=${windowB.toFixed(3)} + ${SAFETY_THRESHOLD}`;
            state.safety.frozen_at = new Date().toISOString();
        }
    }
    else if (state.safety.frozen && windowA <= windowB) {
        // Auto-unfreeze if rates recovered
        state.safety.frozen = false;
        state.safety.frozen_reason = null;
        state.safety.frozen_at = null;
    }
}
function computeWindowedRates(root) {
    const interventions = readAllInterventions(root);
    const now = Date.now();
    const windowMs = SAFETY_WINDOW_DAYS * 24 * 3600000;
    let aTotal = 0, aFail = 0, bTotal = 0, bFail = 0;
    for (const i of interventions) {
        if (i.outcome === "pending" || i.outcome === "indeterminate")
            continue;
        const t = new Date(i.timestamp).getTime();
        const age = now - t;
        if (age <= windowMs) {
            aTotal++;
            if (i.outcome === "reversed_fast")
                aFail++;
        }
        else if (age <= 2 * windowMs) {
            bTotal++;
            if (i.outcome === "reversed_fast")
                bFail++;
        }
    }
    return {
        windowA: aTotal > 0 ? aFail / aTotal : 0,
        windowB: bTotal > 0 ? bFail / bTotal : 0,
    };
}
function isRefactorStorm(root) {
    const recentBursts = readRecentBursts(root, 10);
    if (recentBursts.length < 5)
        return false;
    const refactorCount = recentBursts.filter(b => { var _a; return ((_a = b.pattern) === null || _a === void 0 ? void 0 : _a.type) === "refactor"; }).length;
    const avgChurn = recentBursts.reduce((sum, b) => sum + b.events_count, 0) / recentBursts.length;
    return refactorCount >= 6 && avgChurn > 4;
}
// ── Bypass Rate KPI (Manifesto #8) ───────────────────────────────────────────
function computeBypassRate(root, interventionCount) {
    const bypassPath = resolveUnderRoot(root, ".rl4", ".internal", "cre_bypass.jsonl");
    const raw = readFileSafe(bypassPath);
    if (!raw)
        return 0;
    const bypassCount = raw.trim().split("\n").filter(Boolean).length;
    const total = bypassCount + interventionCount;
    return total > 0 ? bypassCount / total : 0;
}
// ── Deterministic Replay ─────────────────────────────────────────────────────
export function recomputeStateFromLogs(root) {
    const state = createEmptyCREState();
    const interventions = readAllInterventions(root)
        .filter(i => i.outcome !== "pending" && i.outcome !== "indeterminate");
    for (const intervention of interventions) {
        const isFail = intervention.outcome === "reversed_fast";
        const isSoftFail = intervention.outcome === "reworked";
        const isOk = intervention.outcome === "accepted";
        // Treatment arm
        for (const sl of intervention.selected_lessons) {
            const ls = getOrCreateLesson(state, sl.id, sl.type);
            if (isFail)
                ls.injected_fail++;
            else if (isSoftFail)
                ls.injected_soft_fail++;
            else if (isOk) {
                ls.injected_ok++;
                ls.triggers++;
                ls.last_triggered = intervention.timestamp;
            }
        }
        // Control arm
        const selectedBuckets = new Set(intervention.selected_lessons.map(sl => sl.density_bucket));
        for (const cl of intervention.candidate_lessons) {
            if (selectedBuckets.has(cl.density_bucket)) {
                updateBaseline(state, cl.id, cl.type, isFail, isSoftFail, isOk);
            }
            else if (bucketNeighborMatch(cl.density_bucket, selectedBuckets)
                && bucketObservations(state, cl.id) < CRE_PARAMS.BUCKET_MIN_OBS) {
                updateBaseline(state, cl.id, cl.type, isFail, isSoftFail, isOk);
            }
        }
        // Safety counters
        state.safety.total_interventions++;
        if (isFail)
            state.safety.total_reversed_fast++;
        if (isSoftFail)
            state.safety.total_reworked++;
    }
    // Compute KPIs
    if (interventions.length > 0) {
        state.kpis.avg_lessons_injected = interventions.reduce((sum, i) => sum + i.selected_lessons.length, 0) / interventions.length;
        const resolved = interventions.filter(i => i.outcome !== "pending");
        const ok = resolved.filter(i => i.outcome === "accepted").length;
        state.kpis.efficacy_per_lesson = resolved.length > 0 ? ok / resolved.length : 0;
    }
    state.last_updated = new Date().toISOString();
    state.replay_from = "cre_interventions.jsonl";
    return state;
}
// ── I/O Helpers ──────────────────────────────────────────────────────────────
function getInterventionLogPath(root) {
    return resolveUnderRoot(root, ".rl4", ".internal", "cre_interventions.jsonl");
}
export function readAllInterventions(root) {
    const logPath = getInterventionLogPath(root);
    const raw = readFileSafe(logPath);
    if (!raw)
        return [];
    return raw.trim().split("\n").filter(Boolean).map(line => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    }).filter((x) => x !== null);
}
