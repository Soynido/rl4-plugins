/**
 * Query Processor: intent detection, entity extraction, synonym expansion, source bias.
 * Perplexity Stage 1 — zero external deps, pure regex + hardcoded maps.
 */
const INTENT_PATTERNS = [
    {
        intent: "why",
        startsWith: /^(why|pourquoi)\b/i,
        contains: /\b(reason|cause|because|decided|decision|chose|rationale|motivation|justif)/i,
        startConfidence: 0.95,
        containsConfidence: 0.75,
    },
    {
        intent: "how",
        startsWith: /^(how|comment)\b/i,
        contains: /\b(implement|build|create|setup|configure|fix|solve|install|deploy|connect|integrat)/i,
        startConfidence: 0.95,
        containsConfidence: 0.7,
    },
    {
        intent: "when",
        startsWith: /^(when|quand)\b/i,
        contains: /\b(date|time|timeline|before|after|since|last\s+(time|modified|changed)|history)/i,
        startConfidence: 0.9,
        containsConfidence: 0.75,
    },
    {
        intent: "who",
        startsWith: /^(who|qui)\b/i,
        contains: /\b(author|contributor|wrote|created|person|dev|developer)/i,
        startConfidence: 0.9,
        containsConfidence: 0.75,
    },
    {
        intent: "what",
        startsWith: /^(what|quel|que)\b/i,
        contains: /\b(describe|explain|definition|meaning|overview|summary|status)/i,
        startConfidence: 0.85,
        containsConfidence: 0.65,
    },
    {
        intent: "list",
        startsWith: /^(list|show|enumerate|affiche)/i,
        contains: /\b(all\s+(the\s+)?|every|each|enumerate)/i,
        startConfidence: 0.85,
        containsConfidence: 0.7,
    },
    {
        intent: "diff",
        startsWith: /^(diff|compare)/i,
        contains: /\b(difference|compare|versus|vs\.?|changed|between)/i,
        startConfidence: 0.85,
        containsConfidence: 0.7,
    },
];
// ── Source bias per intent ────────────────────────────────────────────────────
const SOURCE_BIAS = {
    why: { decisions: 2.0, timeline: 1.5, evidence: 1.2, chat: 0.8, cli: 0.6 },
    how: { chat: 1.8, timeline: 1.5, cli: 1.5, evidence: 1.2, decisions: 0.8 },
    what: { evidence: 1.8, timeline: 1.5, cli: 1.3, decisions: 1.2, chat: 1.0 },
    when: { timeline: 2.0, evidence: 1.5, cli: 1.3, chat: 1.0, decisions: 0.8 },
    who: { chat: 2.0, timeline: 1.5, evidence: 1.0, decisions: 0.8, cli: 0.5 },
    list: { evidence: 1.8, cli: 1.5, decisions: 1.5, timeline: 1.2, chat: 1.0 },
    diff: { timeline: 1.8, evidence: 1.5, cli: 1.3, decisions: 1.2, chat: 1.0 },
    general: { evidence: 1.0, timeline: 1.0, decisions: 1.0, chat: 1.0, cli: 1.0 },
};
// ── Synonym map (bilingual FR+EN, dev-focused) ──────────────────────────────
const SYNONYMS = {
    auth: ["authentication", "authorization", "login", "signin", "sign-in", "jwt", "token", "oauth", "authentification", "connexion"],
    jwt: ["json web token", "authentication", "token", "auth", "refresh token", "access token"],
    mcp: ["model context protocol", "tool", "server", "mcp server", "mcp tool"],
    rl4: ["snapshot", "evidence", "timeline", "context", "rl4 snapshot"],
    ui: ["interface", "frontend", "component", "render", "display", "view", "webview", "affichage"],
    bug: ["fix", "error", "issue", "defect", "broken", "crash", "erreur", "problème"],
    refactor: ["restructure", "reorganize", "cleanup", "clean up", "simplify", "réorganiser"],
    perf: ["performance", "speed", "optimization", "optimize", "fast", "slow", "latency", "rapide", "lent"],
    db: ["database", "supabase", "postgres", "sql", "query", "table", "base de données"],
    api: ["endpoint", "rest", "route", "handler", "request", "response"],
    snapshot: ["capture", "evidence", "context", "scan", "snapshot headless"],
    toast: ["notification", "message", "info message", "show information message"],
    gate: ["gating", "gate 5", "gate 15", "gate 30", "onboarding", "funnel"],
    extension: ["vsix", "cursor extension", "vscode extension", "plugin"],
    rag: ["retrieval", "search", "bm25", "vector", "embedding", "rerank", "recherche"],
    test: ["testing", "unit test", "spec", "assert", "verify", "vérifier"],
    deploy: ["deployment", "publish", "release", "ship", "déployer"],
    config: ["configuration", "settings", "setup", "paramètre", "réglage"],
    resync: ["sync", "synchronize", "reconnect", "rebind", "mcp resync"],
    cli: ["command", "terminal", "shell", "console", "bash", "zsh", "commande"],
    command: ["cli", "terminal", "shell", "execute", "run", "commande", "lancer"],
    terminal: ["cli", "command", "shell", "console", "bash", "zsh"],
    git: ["commit", "push", "pull", "branch", "merge", "rebase", "stash", "checkout"],
    npm: ["install", "package", "dependency", "node_modules", "yarn", "pnpm"],
    docker: ["container", "image", "compose", "dockerfile", "build"],
    build: ["compile", "bundle", "webpack", "tsc", "rollup", "esbuild", "construire"],
    run: ["execute", "start", "launch", "commande", "lancer"],
};
// ── Entity extraction patterns ──────────────────────────────────────────────
const FILE_PATTERN = /\b[\w./-]+\.(ts|js|json|md|jsonl|mdc|tsx|jsx|py|rs|go|css|html|mjs)\b/g;
const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/g;
const TAG_PATTERN = /\b(FIX|FEAT|ARCH|DEV|UI|DOCS|REFACTOR|ANALYSIS|PERF|TEST|CONFIG|CHAT|CLI|GIT|NPM|DOCKER)\b/gi;
const IDENTIFIER_PATTERN = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
// Tags to exclude from identifiers
const TAG_SET = new Set(["FIX", "FEAT", "ARCH", "DEV", "UI", "DOCS", "REFACTOR", "ANALYSIS", "PERF", "TEST", "CONFIG", "CHAT", "CLI", "GIT", "NPM", "DOCKER"]);
// ── Main entry ──────────────────────────────────────────────────────────────
export function analyzeQuery(query) {
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, " ");
    const { intent, confidence } = detectIntent(normalizedQuery);
    const entities = extractEntities(query);
    const expandedTerms = expandQuery(normalizedQuery, entities);
    const sourceBias = SOURCE_BIAS[intent];
    return {
        originalQuery: query,
        normalizedQuery,
        intent,
        intentConfidence: confidence,
        entities,
        expandedTerms,
        sourceBias,
    };
}
function detectIntent(normalized) {
    for (const p of INTENT_PATTERNS) {
        if (p.startsWith.test(normalized)) {
            return { intent: p.intent, confidence: p.startConfidence };
        }
    }
    for (const p of INTENT_PATTERNS) {
        if (p.contains.test(normalized)) {
            return { intent: p.intent, confidence: p.containsConfidence };
        }
    }
    return { intent: "general", confidence: 0.5 };
}
function extractEntities(query) {
    var _a, _b, _c, _d;
    const files = [...new Set(((_a = query.match(FILE_PATTERN)) !== null && _a !== void 0 ? _a : []))];
    const dates = [...new Set(((_b = query.match(DATE_PATTERN)) !== null && _b !== void 0 ? _b : []))];
    const tags = [...new Set(((_c = query.match(TAG_PATTERN)) !== null && _c !== void 0 ? _c : []).map((t) => t.toUpperCase()))];
    // Identifiers: CamelCase words not in tag set, deduplicated
    const rawIds = ((_d = query.match(IDENTIFIER_PATTERN)) !== null && _d !== void 0 ? _d : []).filter((w) => !TAG_SET.has(w.toUpperCase()));
    const identifiers = [...new Set(rawIds)];
    return { files, dates, tags, identifiers };
}
function expandQuery(normalized, entities) {
    const words = normalized.split(/\s+/);
    const expanded = new Set(words);
    // Add synonyms for each word
    for (const word of words) {
        const syns = SYNONYMS[word];
        if (syns) {
            for (const s of syns)
                expanded.add(s);
        }
    }
    // Add synonyms for identifiers (lowercased)
    for (const id of entities.identifiers) {
        const lower = id.toLowerCase();
        const syns = SYNONYMS[lower];
        if (syns) {
            for (const s of syns)
                expanded.add(s);
        }
        expanded.add(lower);
    }
    // Cap at 20 to avoid BM25 dilution
    return [...expanded].slice(0, 20);
}
