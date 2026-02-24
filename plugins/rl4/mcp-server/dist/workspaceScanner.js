/**
 * Live workspace scanner: walks the workspace directory, respects .gitignore,
 * skips binary/large files, and returns source file paths for on-the-fly code indexing.
 *
 * Used as fallback when .rl4/snapshots/file_index.json doesn't exist (cold start).
 * Designed for speed: hardcoded exclusions skip node_modules/.git immediately,
 * gitignore patterns parsed once, files capped at MAX_FILE_SIZE.
 */
import * as fs from "fs";
import * as path from "path";
// ── Hardcoded exclusions (always skipped, even without .gitignore) ────────────
const ALWAYS_SKIP_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn",
    "dist", "build", "out", ".next", ".nuxt", ".output",
    "__pycache__", ".pytest_cache", ".mypy_cache",
    "target", // Rust
    "vendor", // Go, PHP
    ".rl4", // Our own data
    ".vscode", ".idea", ".cursor",
    "coverage", ".nyc_output",
    ".turbo", ".cache", ".parcel-cache",
    "venv", ".venv", "env", ".env",
]);
const ALWAYS_SKIP_FILES = new Set([
    ".DS_Store", "Thumbs.db", "desktop.ini",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "composer.lock", "Gemfile.lock", "Cargo.lock", "poetry.lock",
]);
// ── Source file extensions we index ──────────────────────────────────────────
const SOURCE_EXTENSIONS = new Set([
    // Web
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".vue", ".svelte", ".astro",
    ".html", ".css", ".scss", ".less", ".sass",
    // Backend
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
    ".php", ".cs", ".swift", ".c", ".cpp", ".h", ".hpp",
    // Config/data (useful for context)
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example",
    ".graphql", ".gql", ".proto", ".sql",
    // Docs
    ".md", ".mdx", ".txt", ".rst",
    // Shell
    ".sh", ".bash", ".zsh", ".fish",
    // Other
    ".prisma", ".dockerfile", ".tf", ".hcl",
]);
/** Max file size to index (500KB — skip large generated files) */
const MAX_FILE_SIZE = 500000;
/** Max total files to index (prevents runaway on huge monorepos) */
const MAX_FILES = 500;
/** Max time for scan (3 seconds — must stay fast) */
const MAX_SCAN_MS = 3000;
function parseGitignore(content) {
    const rules = [];
    for (const rawLine of content.split("\n")) {
        let line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const negated = line.startsWith("!");
        if (negated)
            line = line.slice(1);
        // Remove trailing spaces (unless escaped)
        line = line.replace(/(?<!\\)\s+$/, "");
        if (!line)
            continue;
        // Convert gitignore glob to regex
        let pattern = line
            .replace(/\./g, "\\.") // Escape dots
            .replace(/\*\*/g, "§§") // Temp placeholder for **
            .replace(/\*/g, "[^/]*") // * = anything except /
            .replace(/§§/g, ".*") // ** = anything including /
            .replace(/\?/g, "[^/]"); // ? = single char except /
        // If pattern starts with /, it's anchored to root
        if (pattern.startsWith("/")) {
            pattern = "^" + pattern.slice(1);
        }
        else {
            // Otherwise match anywhere in path
            pattern = "(^|/)" + pattern;
        }
        // If pattern ends with /, it only matches directories
        if (pattern.endsWith("/")) {
            pattern = pattern + ".*";
        }
        else {
            pattern = pattern + "(/.*)?$";
        }
        try {
            rules.push({ pattern: new RegExp(pattern), negated });
        }
        catch {
            // Skip invalid patterns
        }
    }
    return rules;
}
function isIgnored(relativePath, rules) {
    let ignored = false;
    for (const rule of rules) {
        if (rule.pattern.test(relativePath)) {
            ignored = !rule.negated;
        }
    }
    return ignored;
}
/**
 * Scan workspace directory for source files.
 * Fast: skips node_modules/.git immediately, respects .gitignore, caps at MAX_FILES.
 */
export function scanWorkspace(root) {
    const t0 = Date.now();
    const files = [];
    let scannedDirs = 0;
    let skippedDirs = 0;
    let skippedFiles = 0;
    let truncated = false;
    // Load root .gitignore
    const gitignorePath = path.join(root, ".gitignore");
    let ignoreRules = [];
    try {
        if (fs.existsSync(gitignorePath)) {
            ignoreRules = parseGitignore(fs.readFileSync(gitignorePath, "utf-8"));
        }
    }
    catch { /* ignore read errors */ }
    // BFS walk (breadth-first = faster for typical project structures)
    const queue = [root];
    while (queue.length > 0) {
        if (files.length >= MAX_FILES) {
            truncated = true;
            break;
        }
        if (Date.now() - t0 > MAX_SCAN_MS) {
            truncated = true;
            break;
        }
        const dir = queue.shift();
        scannedDirs++;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue; // Permission denied, etc.
        }
        for (const entry of entries) {
            if (files.length >= MAX_FILES) {
                truncated = true;
                break;
            }
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(root, fullPath);
            if (entry.isDirectory()) {
                // Fast skip: hardcoded dirs
                if (ALWAYS_SKIP_DIRS.has(entry.name)) {
                    skippedDirs++;
                    continue;
                }
                // Gitignore check
                if (isIgnored(relativePath, ignoreRules)) {
                    skippedDirs++;
                    continue;
                }
                queue.push(fullPath);
            }
            else if (entry.isFile()) {
                // Fast skip: hardcoded files
                if (ALWAYS_SKIP_FILES.has(entry.name)) {
                    skippedFiles++;
                    continue;
                }
                // Extension check
                const ext = path.extname(entry.name).toLowerCase();
                if (!SOURCE_EXTENSIONS.has(ext)) {
                    skippedFiles++;
                    continue;
                }
                // Gitignore check
                if (isIgnored(relativePath, ignoreRules)) {
                    skippedFiles++;
                    continue;
                }
                // Size check
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) {
                        skippedFiles++;
                        continue;
                    }
                    files.push({ relativePath, absolutePath: fullPath, sizeBytes: stat.size });
                }
                catch {
                    skippedFiles++;
                }
            }
        }
    }
    return {
        files,
        scannedDirs,
        skippedDirs,
        skippedFiles,
        scanTimeMs: Date.now() - t0,
        truncated,
    };
}
