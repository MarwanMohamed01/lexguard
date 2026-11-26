// The rulebook MCP server (M5 step 4, D46): three read-only tools over the pinned rulebooks.
//
//   get_rule     { id: "gdpr:28(3)(a)" }                 -> that rule's exact text and citation
//   list_rules   { source: "gdpr", article: "28" }        -> every rule of one article
//   search_rules { query: "sub-processor authorisation" } -> best keyword matches (BM25)
//
// A fresh server per request (createMcpHandler, stateless): nothing is remembered between
// calls, so no Durable Object. Who may call is decided in front of this handler (OAuth, step
// 4b); this file only knows which tools exist and validates their arguments with Zod.
import {
  gdpr,
  getRule,
  ndaPlaybook,
  ruleText,
  rulesOfArticle,
  searchRules,
} from "@lexguard/rulebook";
import type { Rule, Rulebook } from "@lexguard/rulebook";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Bumped whenever a tool's name, description or schema changes (clients may pin them, M7). */
export const SERVER_VERSION = "0.1.0";

export const RULEBOOKS: ReadonlyMap<string, Rulebook> = new Map([
  ["gdpr", gdpr],
  ["nda", ndaPlaybook],
]);

const SOURCES = ["gdpr", "nda"] as const;

/**
 * One search corpus holding every rulebook's rules (IDs keep their own prefix). BM25 scores
 * depend on the word statistics of the corpus they come from: "confidential" is in nearly
 * every NDA rule (so it counts little there) but rare in the GDPR (so it counts a lot).
 * Scores from two separately searched books are therefore not comparable, the same lesson as
 * bm25 vs cosine in M3 (D27). Searching one combined corpus gives every rule the same
 * statistics. Used for search only; lookups use each rulebook.
 */
export const ALL_RULES: Rulebook = (() => {
  let text = "";
  const rules: Rule[] = [];
  for (const book of RULEBOOKS.values()) {
    if (text !== "") text += "\n";
    const offset = text.length;
    text += book.text;
    for (const r of book.rules) rules.push({ ...r, start: r.start + offset, end: r.end + offset });
  }
  return {
    source: { ...gdpr.source, id: "all", title: "All rulebooks (search corpus)" },
    text,
    rules,
  };
})();

const bookOf = (id: string) => RULEBOOKS.get(id.slice(0, id.indexOf(":")));

/** A rule as tools return it: citation fields plus its exact text. */
export interface RuleView {
  id: string;
  source: string;
  article: string;
  title: string;
  text: string;
}

const view = (book: Rulebook, rule: Rule): RuleView => ({
  id: rule.id,
  source: book.source.id,
  article: rule.article,
  title: rule.title,
  text: ruleText(book, rule),
});

const RuleViewSchema = z.object({
  id: z.string(),
  source: z.string(),
  article: z.string(),
  title: z.string(),
  text: z.string(),
});

// Rule IDs look like gdpr:28(3)(a), gdpr:28(3)/2, gdpr:53(1)-2, nda:11. The pattern keeps
// arbitrary text out of lookups and error messages.
const RULE_ID = /^[a-z]+:[0-9]{1,3}(?:\([0-9a-z]{1,4}\)|-[0-9]{1,2})*(?:\/[0-9]{1,2})?$/;

const ok = <T extends Record<string, unknown>>(data: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data,
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false, // pinned data only, no web access
};

export function createRulebookServer(): McpServer {
  const server = new McpServer({ name: "lexguard-rulebook", version: SERVER_VERSION });

  server.registerTool(
    "get_rule",
    {
      title: "Get a rule",
      description:
        "Returns one rule's exact text and citation by its ID, e.g. gdpr:28(3)(a) (GDPR Article 28, " +
        "paragraph 3, point (a)) or nda:11 (NDA playbook rule 11). IDs follow legal citation; /2 is " +
        "a second subparagraph, -1 an unnumbered indent.",
      inputSchema: z.object({ id: z.string().max(40).regex(RULE_ID, "not a rule ID") }),
      outputSchema: z.object({ rule: RuleViewSchema }),
      annotations: READ_ONLY,
    },
    ({ id }) => {
      const book = bookOf(id);
      const rule = book === undefined ? undefined : getRule(book, id);
      if (book === undefined || rule === undefined) return fail(`No rule with ID ${id}.`);
      return ok({ rule: view(book, rule) });
    },
  );

  server.registerTool(
    "list_rules",
    {
      title: "List an article's rules",
      description:
        "Returns every rule of one article (GDPR) or one playbook rule (nda), in order, with text.",
      inputSchema: z.object({
        source: z.enum(SOURCES),
        article: z.string().regex(/^[0-9]{1,3}$/, "an article number"),
      }),
      outputSchema: z.object({ rules: z.array(RuleViewSchema) }),
      annotations: READ_ONLY,
    },
    ({ source, article }) => {
      const book = RULEBOOKS.get(source);
      if (book === undefined) return fail(`Unknown source ${source}.`);
      const rules = rulesOfArticle(book, String(Number(article)));
      if (rules.length === 0) return fail(`No article ${article} in ${source}.`);
      return ok({ rules: rules.map((r) => view(book, r)) });
    },
  );

  server.registerTool(
    "search_rules",
    {
      title: "Search rules by keywords",
      description:
        "Keyword search (BM25) over rule texts and titles; returns the best matches with their text. " +
        "For finding a rule, not for deciding compliance.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        source: z.enum(SOURCES).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      outputSchema: z.object({
        hits: z.array(z.object({ rule: RuleViewSchema, score: z.number() })),
      }),
      annotations: READ_ONLY,
    },
    ({ query, source, limit }) => {
      const corpus = source === undefined ? ALL_RULES : RULEBOOKS.get(source);
      if (corpus === undefined) return fail(`Unknown source ${String(source)}.`);
      const hits = searchRules(corpus, query, limit).flatMap(({ id, score }) => {
        const book = bookOf(id);
        const rule = book === undefined ? undefined : getRule(book, id);
        if (book === undefined || rule === undefined) return [];
        return [{ rule: view(book, rule), score: Math.round(score * 1000) / 1000 }];
      });
      return ok({ hits });
    },
  );

  return server;
}

/** The web-standard MCP handler: `handler.fetch(request)` serves one MCP HTTP exchange. */
export function rulebookHandler(): McpHttpHandler {
  return createMcpHandler(() => createRulebookServer(), {
    responseMode: "json", // no streaming needed: every tool answers at once
    maxRequestBodySize: 16_384, // tool calls are tiny; refuse large bodies early (T15)
  });
}
