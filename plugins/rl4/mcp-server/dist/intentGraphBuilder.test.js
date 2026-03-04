/**
 * TDD tests for Residual Risks R3 (Boilerplate False-Positive) and R4 (Sliding Window Paradox).
 *
 * These tests target the deterministic IntentGraph builder pipeline.
 * R3: suggestion_rejected must use hunk intersection, NOT naive substring match.
 * R4: detectReversalsMetadata + enrichReversalsWithBlobDiff must detect multi-hop reverts.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { detectReversalsMetadata, enrichReversalsWithBlobDiff, getRevertedLineRange, simpleHash, REVERSAL_WINDOW, } from "./intentGraphBuilder";
// ── Helpers ──────────────────────────────────────────────────────────────
function mkVersion(index, sha256, delta, timestamp) {
    return {
        sha256,
        timestamp: timestamp !== null && timestamp !== void 0 ? timestamp : new Date(2026, 1, 28, 10, index).toISOString(),
        causing_prompt: { chat_ref: `chat-${index}`, thread_id: `thread-${index}`, delay_ms: 100 },
        delta,
        intent_signal: "edit",
        version_index: index,
    };
}
function mkChain(file, versions, reversals = []) {
    return {
        file,
        versions,
        events: versions.map((v, i) => ({
            t: v.timestamp,
            file,
            from_sha256: i > 0 ? versions[i - 1].sha256 : null,
            to_sha256: v.sha256,
            delta: v.delta,
            intent_signal: v.intent_signal,
            causing_prompt: v.causing_prompt,
            burst_id: null,
        })),
        reversals,
        trajectory: "linear",
        hot_score: 0,
        totalReversals: reversals.length,
    };
}
/** Write blob content to a temp snapshots directory and return the dir path. */
function writeSnapshots(blobs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl4-test-snapshots-"));
    for (const [sha, content] of Object.entries(blobs)) {
        fs.writeFileSync(path.join(dir, `${sha}.content`), content, "utf-8");
    }
    return dir;
}
// ── R3: Boilerplate False-Positive Test ──────────────────────────────────
//
// Chain model: v0 (pre-edit) → v1 (post-LLM-edit) → v2 (user revert)
// The suggestion was applied between v0 and v1 (events[1].from_sha256 = v0's sha).
// enrichReversalsWithBlobDiff processes pair (i=1, vj=v2) and reads the pre-edit
// blob via chain.events[1].from_sha256 to locate where old_string was.
describe("R3 — Hunk-aware suggestion_rejected (eliminates false positives)", () => {
    test("Edit suggestion on line 10 must NOT trigger suggestion_rejected when only line 50 is reverted", () => {
        // PRE-EDIT blob (v0): line 10 = "  // line 10", line 50 = "  return false;" (already existed)
        const preLines = [];
        for (let i = 1; i <= 60; i++) {
            if (i === 50)
                preLines.push("  return false;"); // already exists before the edit
            else
                preLines.push(`  // line ${i}`);
        }
        const blobV0 = preLines.join("\n"); // pre-edit
        // POST-EDIT blob (v1): LLM edited line 10 → "  return false;"
        const postLines = [...preLines];
        postLines[9] = "  return false;"; // line 10 changed by LLM
        const blobV1 = postLines.join("\n"); // post-edit: "return false;" on BOTH line 10 and 50
        // USER REVERT blob (v2): user reverted ONLY line 50 back
        const revertLines = [...postLines];
        revertLines[49] = "  return true;"; // line 50 reverted by user
        const blobV2 = revertLines.join("\n");
        // The suggestion: LLM edited line 10 from "  // line 10" to "  return false;"
        const suggestion = {
            hash: simpleHash("  return false;"),
            content: "  return false;", // new_string (what LLM wrote)
            old_string: "  // line 10", // old_string (what was replaced on line 10)
            intervention_id: "test-r3-neg",
            tool_name: "Edit",
        };
        const suggestions = new Map();
        suggestions.set("test.ts", [suggestion]);
        const v0 = mkVersion(0, "sha-r3-v0", { linesAdded: 60, linesRemoved: 0, netChange: 60 });
        const v1 = mkVersion(1, "sha-r3-v1", { linesAdded: 1, linesRemoved: 1, netChange: 0 });
        const v2 = mkVersion(2, "sha-r3-v2", { linesAdded: 1, linesRemoved: 1, netChange: 0 });
        const snapshotsDir = writeSnapshots({
            "sha-r3-v0": blobV0,
            "sha-r3-v1": blobV1,
            "sha-r3-v2": blobV2,
        });
        // Chain: v0 → v1 → v2. Reversal between v1 and v2 (user revert on line 50).
        const chain = mkChain("test.ts", [v0, v1, v2], [
            {
                from_version: 1,
                to_version: 2,
                reverted_lines: 1,
                reversal_ratio: 0.5,
                thread_changed: false,
                time_gap_hours: 0.1,
            },
        ]);
        enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions);
        // Assert: suggestion_rejected must be FALSE.
        // old_string "  // line 10" is at line 10 in v0 (pre-edit). The revert is at line 50.
        // No overlap → not a suggestion rejection.
        const rev = chain.reversals.find(r => r.from_version === 1 && r.to_version === 2);
        expect(rev).toBeDefined();
        expect(rev.suggestion_rejected).not.toBe(true);
        fs.rmSync(snapshotsDir, { recursive: true, force: true });
    });
    test("Edit suggestion on line 50 MUST trigger suggestion_rejected when line 50 is reverted", () => {
        // PRE-EDIT blob (v0): line 50 = "  // line 50"
        const preLines = [];
        for (let i = 1; i <= 60; i++) {
            preLines.push(`  // line ${i}`);
        }
        const blobV0 = preLines.join("\n");
        // POST-EDIT blob (v1): LLM edited line 50 → "  return false;"
        const postLines = [...preLines];
        postLines[49] = "  return false;"; // line 50 changed by LLM
        const blobV1 = postLines.join("\n");
        // USER REVERT blob (v2): user reverted line 50 back
        const revertLines = [...postLines];
        revertLines[49] = "  return true;"; // line 50 reverted
        const blobV2 = revertLines.join("\n");
        const suggestion = {
            hash: simpleHash("  return false;"),
            content: "  return false;",
            old_string: "  // line 50", // old_string is at line 50 in v0
            intervention_id: "test-r3-pos",
            tool_name: "Edit",
        };
        const suggestions = new Map();
        suggestions.set("test.ts", [suggestion]);
        const v0 = mkVersion(0, "sha-r3p-v0", { linesAdded: 60, linesRemoved: 0, netChange: 60 });
        const v1 = mkVersion(1, "sha-r3p-v1", { linesAdded: 1, linesRemoved: 1, netChange: 0 });
        const v2 = mkVersion(2, "sha-r3p-v2", { linesAdded: 1, linesRemoved: 1, netChange: 0 });
        const snapshotsDir = writeSnapshots({
            "sha-r3p-v0": blobV0,
            "sha-r3p-v1": blobV1,
            "sha-r3p-v2": blobV2,
        });
        const chain = mkChain("test.ts", [v0, v1, v2], [
            {
                from_version: 1,
                to_version: 2,
                reverted_lines: 1,
                reversal_ratio: 0.5,
                thread_changed: false,
                time_gap_hours: 0.1,
            },
        ]);
        enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions);
        // Assert: suggestion_rejected MUST be true.
        // old_string "  // line 50" is at line 50 in v0 (pre-edit).
        // The revert is also at line 50 → overlap → suggestion was rejected.
        const rev = chain.reversals.find(r => r.from_version === 1 && r.to_version === 2);
        expect(rev).toBeDefined();
        expect(rev.suggestion_rejected).toBe(true);
        fs.rmSync(snapshotsDir, { recursive: true, force: true });
    });
});
// ── R3 helper unit test ──────────────────────────────────────────────────
describe("getRevertedLineRange", () => {
    test("detects removed lines in the middle of a file", () => {
        const before = "a\nb\nc\nd\ne";
        const after = "a\nd\ne"; // lines b,c removed (1-based: lines 2,3)
        const ranges = getRevertedLineRange(before, after);
        expect(ranges.length).toBeGreaterThanOrEqual(1);
        // The range should cover lines 2-3
        const covers2 = ranges.some(r => r.start <= 2 && r.end >= 2);
        const covers3 = ranges.some(r => r.start <= 3 && r.end >= 3);
        expect(covers2).toBe(true);
        expect(covers3).toBe(true);
    });
    test("detects changed line at end of file", () => {
        const before = "a\nb\nc";
        const after = "a\nb"; // line c removed (line 3)
        const ranges = getRevertedLineRange(before, after);
        expect(ranges.length).toBeGreaterThanOrEqual(1);
        const covers3 = ranges.some(r => r.start <= 3 && r.end >= 3);
        expect(covers3).toBe(true);
    });
    test("returns empty for identical files", () => {
        const ranges = getRevertedLineRange("a\nb\nc", "a\nb\nc");
        expect(ranges).toEqual([]);
    });
});
// ── R4: Sliding Window Paradox Test ──────────────────────────────────────
describe("R4 — Sliding Window reversal detection (WINDOW=3)", () => {
    test("REVERSAL_WINDOW constant is 3", () => {
        expect(REVERSAL_WINDOW).toBe(3);
    });
    test("detectReversalsMetadata detects v0→v3 reversal through intermediate versions", () => {
        // v0: baseline (adds 20 lines)
        // v1: minor edit (adds 2, removes 0) — not a reversal of v0
        // v2: typo fix (adds 1, removes 1) — not a reversal
        // v3: revert back to v0 state (adds 0, removes 20) — reversal of v0
        const versions = [
            mkVersion(0, "sha-v0", { linesAdded: 20, linesRemoved: 0, netChange: 20 }),
            mkVersion(1, "sha-v1", { linesAdded: 2, linesRemoved: 0, netChange: 2 }),
            mkVersion(2, "sha-v2", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
            mkVersion(3, "sha-v3", { linesAdded: 0, linesRemoved: 20, netChange: -20 }),
        ];
        const reversals = detectReversalsMetadata(versions);
        // There MUST be a reversal where from_version=0 and to_version=3
        // (v0 added 20 lines, v3 removed 20 lines → score = min(20,20)/max(1,20) = 1.0 > 0.4)
        const v0_v3 = reversals.find(r => r.from_version === 0 && r.to_version === 3);
        expect(v0_v3).toBeDefined();
        expect(v0_v3.reversal_ratio).toBeGreaterThanOrEqual(0.4);
    });
    test("detectReversalsMetadata still detects adjacent v0→v1 reversals", () => {
        // Ensure WINDOW doesn't break adjacent detection
        const versions = [
            mkVersion(0, "sha-a", { linesAdded: 10, linesRemoved: 0, netChange: 10 }),
            mkVersion(1, "sha-b", { linesAdded: 0, linesRemoved: 10, netChange: -10 }),
        ];
        const reversals = detectReversalsMetadata(versions);
        expect(reversals.length).toBe(1);
        expect(reversals[0].from_version).toBe(0);
        expect(reversals[0].to_version).toBe(1);
    });
    test("enrichReversalsWithBlobDiff detects exact content revert v0→v3 via blob comparison", () => {
        // v0: baseline content
        // v1: modified
        // v2: modified further
        // v3: content identical to v0 (exact revert)
        const baseContent = "function hello() {\n  return 'world';\n}\n";
        const v1Content = "function hello() {\n  return 'changed';\n}\n";
        const v2Content = "function hello() {\n  return 'changed again';\n}\n";
        const v3Content = baseContent; // exact revert to v0
        const snapshotsDir = writeSnapshots({
            "sha-base": baseContent,
            "sha-v1c": v1Content,
            "sha-v2c": v2Content,
            "sha-v3c": v3Content,
        });
        const versions = [
            mkVersion(0, "sha-base", { linesAdded: 3, linesRemoved: 0, netChange: 3 }),
            mkVersion(1, "sha-v1c", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
            mkVersion(2, "sha-v2c", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
            mkVersion(3, "sha-v3c", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
        ];
        const chain = mkChain("hello.ts", versions, []);
        const suggestions = new Map();
        enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions);
        // The enrichment should detect that v3 content === v0 content (2 hops back via REVERSAL_WINDOW)
        // This requires the lookback to check i-2 (v0) when processing i=2, vj=v3
        const revert = chain.reversals.find(r => r.reversal_ratio === 1.0);
        expect(revert).toBeDefined();
        fs.rmSync(snapshotsDir, { recursive: true, force: true });
    });
    test("enrichReversalsWithBlobDiff does NOT false-positive a non-revert", () => {
        const v0 = "aaa\n";
        const v1 = "bbb\n";
        const v2 = "ccc\n"; // different from both v0 and v1
        const snapshotsDir = writeSnapshots({
            "sha-nr0": v0,
            "sha-nr1": v1,
            "sha-nr2": v2,
        });
        const versions = [
            mkVersion(0, "sha-nr0", { linesAdded: 1, linesRemoved: 0, netChange: 1 }),
            mkVersion(1, "sha-nr1", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
            mkVersion(2, "sha-nr2", { linesAdded: 1, linesRemoved: 1, netChange: 0 }),
        ];
        const chain = mkChain("norevert.ts", versions, []);
        const suggestions = new Map();
        enrichReversalsWithBlobDiff(chain, snapshotsDir, suggestions);
        // No exact revert should be detected
        const exactRevert = chain.reversals.find(r => r.reversal_ratio === 1.0);
        expect(exactRevert).toBeUndefined();
        fs.rmSync(snapshotsDir, { recursive: true, force: true });
    });
});
