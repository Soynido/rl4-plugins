/**
 * RL4 workspace paths and file reads.
 * Workspace root: RL4_WORKSPACE_ROOT env, or first CLI arg, or cwd.
 * Uses safe path resolution to prevent traversal (SAST path.join finding).
 */
import * as fs from "fs";
import * as path from "path";
import { resolveUnderRoot } from "./safePath.js";
export function getWorkspaceRoot() {
    var _a;
    const fromEnv = (_a = process.env.RL4_WORKSPACE_ROOT) !== null && _a !== void 0 ? _a : process.env.CURSOR_WORKSPACE_DIR;
    if (fromEnv)
        return path.resolve(fromEnv);
    const fromArg = process.argv[2];
    if (fromArg)
        return path.resolve(fromArg);
    return process.cwd();
}
const PATHS = {
    evidence: ".rl4/evidence.md",
    timeline: ".rl4/timeline.md",
    decisionsRl4: ".rl4/evidence/decisions.jsonl",
    decisionsReasoning: ".reasoning_rl4/cognitive/decisions.jsonl",
    intentGraph: ".rl4/intent_graph.json",
};
export function getEvidencePath(root) {
    return resolveUnderRoot(root, ".rl4", "evidence.md");
}
export function getTimelinePath(root) {
    return resolveUnderRoot(root, ".rl4", "timeline.md");
}
export function getDecisionsPath(root) {
    const rl4 = resolveUnderRoot(root, ".rl4", "evidence", "decisions.jsonl");
    if (fs.existsSync(rl4))
        return rl4;
    const reasoning = resolveUnderRoot(root, ".reasoning_rl4", "cognitive", "decisions.jsonl");
    if (fs.existsSync(reasoning))
        return reasoning;
    return rl4; // default to .rl4 path
}
export function getIntentGraphPath(root) {
    return resolveUnderRoot(root, ".rl4", "intent_graph.json");
}
/** Read MIG intent_graph.json. Returns formatted string or message if missing. */
export function readIntentGraph(root) {
    const content = readFileSafe(getIntentGraphPath(root));
    if (!content)
        return "[No intent_graph.json found. MIG is built by the extension (IntentGraphBuilder) after file activity.]";
    return `Source: .rl4/intent_graph.json\n\n${content}`;
}
export function readFileSafe(filePath, encoding = "utf-8") {
    try {
        if (!fs.existsSync(filePath))
            return null;
        return fs.readFileSync(filePath, encoding);
    }
    catch {
        return null;
    }
}
export function readEvidence(root) {
    const content = readFileSafe(getEvidencePath(root));
    if (!content)
        return "[No evidence.md found. Install RL4 extension and run the workspace to generate .rl4/evidence.md]";
    return `Source: .rl4/evidence.md\n\n${content}`;
}
export function readTimeline(root) {
    const content = readFileSafe(getTimelinePath(root));
    if (!content)
        return "[No timeline.md found. Install RL4 extension and run the workspace to generate .rl4/timeline.md]";
    return `Source: .rl4/timeline.md\n\n${content}`;
}
export function readDecisions(root) {
    var _a, _b, _c, _d, _e;
    const decisionsPath = getDecisionsPath(root);
    const raw = readFileSafe(decisionsPath);
    if (!raw)
        return [];
    const lines = raw.trim().split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
        try {
            const d = JSON.parse(line);
            out.push({
                id: String((_a = d.id) !== null && _a !== void 0 ? _a : ""),
                intent_text: String((_b = d.intent_text) !== null && _b !== void 0 ? _b : ""),
                chosen_option: String((_c = d.chosen_option) !== null && _c !== void 0 ? _c : ""),
                confidence_gate: String((_d = d.confidence_gate) !== null && _d !== void 0 ? _d : ""),
                isoTimestamp: String((_e = d.isoTimestamp) !== null && _e !== void 0 ? _e : ""),
            });
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
export function formatDecisionsForResource(decisions) {
    if (decisions.length === 0)
        return "Source: decisions.jsonl\n\n[No decisions found.]";
    const header = "Source: .rl4/evidence/decisions.jsonl or .reasoning_rl4/cognitive/decisions.jsonl\n\n";
    const body = decisions
        .map((d) => `- [${d.id}] ${d.isoTimestamp} | ${d.intent_text} → ${d.chosen_option} (gate: ${d.confidence_gate})`)
        .join("\n");
    return header + body;
}
