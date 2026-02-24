/**
 * Resolves segments under root and ensures the result does not escape root.
 * Throws if any segment contains '..' or if resolved path is outside root.
 */
export declare function resolveUnderRoot(root: string, ...segments: string[]): string;
