/**
 * Safe path resolution under a workspace root — prevents path traversal.
 * All path.join(root, ...) with request or env-derived root/segments should use this.
 */
import * as path from "path";
/**
 * Resolves segments under root and ensures the result does not escape root.
 * Throws if any segment contains '..' or if resolved path is outside root.
 */
export function resolveUnderRoot(root, ...segments) {
    const rootResolved = path.resolve(root);
    for (const seg of segments) {
        if (seg.includes("..")) {
            throw new Error("Path traversal not allowed");
        }
    }
    const resolved = path.resolve(rootResolved, ...segments);
    const relative = path.relative(rootResolved, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Path traversal not allowed");
    }
    return resolved;
}
