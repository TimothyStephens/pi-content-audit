/**
 * pi-content-audit core: the report, the subcommands and the viewer — everything
 * but reading the host's prompt.
 *
 * Registers exactly one command (see `register`):
 *   /content-audit — context audit: ordered list of loaded context items
 *                    (skills, rules, extensions, tools, environment, context
 *                    files) with exact injected text & source paths.
 *                    Subcommands keep the flat report (prompt, section, file,
 *                    tools, json).
 *
 * Host-neutral: no import of a host package. The two hosts build their system
 * prompts differently, so each entry point brings a collector:
 *   omp.ts — OMP: prompt parts with <skills>, <generic-rules>, <domain-rules>,
 *            <workstation> and <repo-rules><file path=…> blocks, rules from
 *            OMP's capability module;
 *   pi.ts  — Pi: one prompt of <tools>, <rules>, <project_context>, <skills>,
 *            <cwd> … sections, plus ctx.getSystemPromptOptions() for the
 *            context files and skills as data.
 * Both return the same AuditData and LoadedItem shapes, rendered here.
 *
 * Companion extension: pi-session-stats (/session-stats).
 * No tools, no hooks, no flags, no dashboard.
 */
import * as fs from "node:fs";
import { type Block, type UiKit, type ViewCtx, present, presentDoc } from "./pager.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const tokOfChars = (n: number) => Math.max(0, Math.ceil(n / 4)); // chars/4 convention (matches pi-devtools)
export const tok = (s: string) => tokOfChars(s.length);
const DUMP_CAP = 200_000; // display cap for body dumps

export const comma = (n: number): string => n.toLocaleString("en-US");

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function dumpCap(text: string): string {
  if (text.length <= DUMP_CAP) return text;
  return `${text.slice(0, DUMP_CAP)}\n… truncated (${comma(text.length - DUMP_CAP)} more chars)`;
}

export const diskSize = (p: string): number | undefined => {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Data shapes both collectors fill
// ---------------------------------------------------------------------------

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface RepoFile {
  path: string;
  chars: number; // inner injected content chars
  content: string;
  diskBytes?: number;
}

export interface TagMatch {
  tag: string;
  start: number;
  end: number;
  chars: number;
  content: string;
}

export interface AuditTool {
  name: string;
  source: string;
  path: string;
  scope: string;
  origin: string;
  baseDir: string;
  tokens: number;
}

export interface AuditSection {
  tag: string;
  chars: number;
  tokens: number;
  files?: RepoFile[];
  skillCount?: number;
}

export interface AuditData {
  model: string;
  cwd: string;
  contextUsage?: ContextUsageLike;
  /** The prompt text exactly as the host returned it (OMP: several parts; Pi: one). */
  rawParts: string[];
  parts: { chars: number; tokens: number; lines: number }[];
  totalChars: number;
  totalTokens: number;
  sections: AuditSection[];
  untaggedChars: number;
  tools: AuditTool[];
  skills: { name: string; dir: string; sizeBytes: number; loaded: boolean }[];
  repoFiles: RepoFile[];
  tagMatches: { tag: string; partIdx: number; content: string }[];
}

export type ItemKind =
  | "context-file" // AGENTS/CLAUDE context file (OMP <repo-rules> <file>, Pi <project_instructions>)
  | "skill" // a skill (its listing line/block; full SKILL.md on disk)
  | "generic-rule" // OMP: always-apply rule content (from <generic-rules>)
  | "domain-rule" // OMP: a domain rule (- name (globs): desc; full file on disk)
  | "guidelines" // Pi: the <rules> section (tool guidelines + extension prompt guidelines)
  | "tool-list" // Pi: the <tools> section (one snippet line per active tool)
  | "addendum" // Pi: the <addendum> section (APPEND_SYSTEM.md / --append-system-prompt)
  | "docs" // Pi: the <docs> section (pointer to Pi's own documentation)
  | "section" // Pi: any other prompt section (one an extension added)
  | "extension" // one installed extension (its tools, grouped by sourceInfo.baseDir)
  | "mcp-tools" // MCP-provided tools (grouped)
  | "built-in-tools" // built-in/sdk tools (grouped into one item)
  | "environment"; // OMP <workstation> / Pi <cwd> block (built-in, no file)

export interface LoadedItem {
  kind: ItemKind;
  label: string; // row text: file path | skill name | rule name | ext name | "environment"
  path?: string; // absolute source file path; undefined for built-ins
  injectedText: string; // EXACT text added to the prompt (verbatim sub-section)
  injectedChars: number;
  injectedTokens: number;
  note?: string; // e.g. "name+desc only; full content via skill://<name>"
  diskBytes?: number; // set when path exists on disk
}

export interface AuditSummary {
  itemCount: number;
  systemPromptTokens: number; // sum tok(part) over ALL prompt parts (the true total)
  attributedTokens: number; // sum tok(item.injectedText) — the part explained by items
  contextUsage?: ContextUsageLike;
}

export const mk = (it: Omit<LoadedItem, "injectedChars" | "injectedTokens">): LoadedItem => ({
  ...it,
  injectedChars: it.injectedText.length,
  injectedTokens: tok(it.injectedText),
});

// ---------------------------------------------------------------------------
// Prompt scanning shared by both collectors
// ---------------------------------------------------------------------------

/** Generic top-level tag scan (no hard-coded tag list). */
export function scanTags(text: string) {
  const re = /<([a-z][a-z0-9_-]*)[^>]*>([\s\S]*?)<\/\1>/g;
  const all: TagMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    all.push({ tag: m[1], start: m.index, end: re.lastIndex, chars: m[0].length, content: m[2] });
  }
  const top = all.filter((a) => !all.some((b) => b !== a && b.start < a.start && a.end <= b.end));
  const tagged = top.reduce((s, t) => s + t.chars, 0);
  return { top, all, tagged, untagged: text.length - tagged };
}

export interface PromptScan {
  partStats: { chars: number; tokens: number; lines: number }[];
  totalChars: number;
  tagAgg: Map<string, { chars: number; parts: number }>;
  tagMatches: { tag: string; partIdx: number; content: string }[];
  untaggedChars: number;
}

/** Per-part sizes and top-level tag matches, in prompt order. */
export function scanPrompt(parts: string[]): PromptScan {
  const partStats = parts.map((p) => ({ chars: p.length, tokens: tok(p), lines: p ? p.split("\n").length : 0 }));
  const tagAgg = new Map<string, { chars: number; parts: number }>();
  const tagMatches: { tag: string; partIdx: number; content: string }[] = [];
  let untaggedChars = 0;
  parts.forEach((part, partIdx) => {
    const { top, untagged } = scanTags(part);
    untaggedChars += untagged;
    for (const t of top) {
      const a = tagAgg.get(t.tag) ?? { chars: 0, parts: 0 };
      a.chars += t.chars;
      a.parts += 1;
      tagAgg.set(t.tag, a);
      tagMatches.push({ tag: t.tag, partIdx, content: t.content });
    }
  });
  return { partStats, totalChars: partStats.reduce((s, p) => s + p.chars, 0), tagAgg, tagMatches, untaggedChars };
}

/** Sections table rows, largest first; `files`/`skillCount` hang off the named tags. */
export function sectionsOf(
  scan: PromptScan,
  extra: { filesTag: string; files: RepoFile[]; skillsTag: string; skillCount: number },
): AuditSection[] {
  return [...scan.tagAgg.entries()]
    .map(([tag, a]) => ({
      tag,
      chars: a.chars,
      tokens: tokOfChars(a.chars),
      files: tag === extra.filesTag ? extra.files : undefined,
      skillCount: tag === extra.skillsTag ? extra.skillCount : undefined,
    }))
    .sort((a, b) => b.chars - a.chars);
}

/** The fields of a host ToolInfo both hosts have. */
export interface ToolLike {
  name: string;
  description?: string;
  promptGuidelines?: readonly string[];
  sourceInfo?: { source?: string; path?: string; scope?: string; origin?: string; baseDir?: string };
}

export function toolRows(tools: readonly ToolLike[]): AuditTool[] {
  return tools.map((t) => ({
    name: t.name,
    source: t.sourceInfo?.source ?? "?",
    path: t.sourceInfo?.path ?? "",
    scope: t.sourceInfo?.scope ?? "",
    origin: t.sourceInfo?.origin ?? "",
    baseDir: t.sourceInfo?.baseDir ?? "",
    tokens: tok(t.name + "\n" + (t.description ?? "") + "\n" + (t.promptGuidelines ?? []).join("\n")),
  }));
}

/** Tools → one item per extension (by baseDir), one for MCP tools, one for built-ins. */
export function toolItems(tools: readonly ToolLike[], builtinNote: string): LoadedItem[] {
  const items: LoadedItem[] = [];
  const footprint = (t: ToolLike): string =>
    t.promptGuidelines && t.promptGuidelines.length
      ? `${t.name}: ${t.description ?? ""}\n${t.promptGuidelines.join("\n")}`
      : `${t.name}: ${t.description ?? ""}`;
  const extGroups = new Map<string, ToolLike[]>();
  const mcpTools: ToolLike[] = [];
  const builtinTools: ToolLike[] = [];
  for (const t of tools) {
    const src = t.sourceInfo?.source;
    if (src === "extension") {
      const key = t.sourceInfo?.baseDir ?? t.sourceInfo?.path ?? "?";
      const g = extGroups.get(key) ?? [];
      g.push(t);
      extGroups.set(key, g);
    } else if (src === "mcp") mcpTools.push(t);
    else builtinTools.push(t); // builtin, sdk, unknown
  }
  for (const [key, group] of extGroups) {
    const baseDir = group[0].sourceInfo?.baseDir;
    items.push(
      mk({
        kind: "extension",
        label: baseDir ? baseDir.split(/[\\/]/).filter(Boolean).pop() ?? key : key,
        path: baseDir,
        injectedText: group.map(footprint).join("\n"),
        note: `${group.length} tool(s)`,
      }),
    );
  }
  if (mcpTools.length)
    items.push(mk({ kind: "mcp-tools", label: "MCP tools", injectedText: mcpTools.map(footprint).join("\n"), note: `${mcpTools.length} tool(s)` }));
  if (builtinTools.length)
    items.push(
      mk({
        kind: "built-in-tools",
        label: "built-in tools",
        injectedText: builtinTools.map(footprint).join("\n"),
        note: `${builtinTools.length} tool(s); ${builtinNote}`,
      }),
    );
  return items;
}

export function diskNote(f: RepoFile): string {
  if (f.diskBytes === undefined) return "missing on disk";
  if (new TextEncoder().encode(f.content).length === f.diskBytes) return `disk ${comma(f.diskBytes)} B ✓`;
  return `≠ disk ${comma(f.diskBytes)} B`;
}

// ---------------------------------------------------------------------------
// The audit document: totals, prompt share by type, one row per item, then
// each item's exact injected text. Laid out by pager.ts; also the no-UI output.
// ---------------------------------------------------------------------------

const ITEM_TEXT_CAP = 20_000; // per-item display cap for injected text (chars)

function capItemText(t: string): { text: string; hidden: number } {
  if (t.length <= ITEM_TEXT_CAP) return { text: t, hidden: 0 };
  let cut = t.lastIndexOf("\n", ITEM_TEXT_CAP); // cut at a line boundary
  if (cut < ITEM_TEXT_CAP / 2) cut = ITEM_TEXT_CAP;
  return { text: t.slice(0, cut), hidden: t.length - cut };
}

/** Short type names for the tables; several kinds share one (both tool groupings are "tools"). */
const TYPE_LABEL: Record<ItemKind, string> = {
  "context-file": "file",
  skill: "skill",
  "generic-rule": "rules",
  "domain-rule": "rule",
  guidelines: "guidelines",
  "tool-list": "tools",
  addendum: "addendum",
  docs: "docs",
  section: "section",
  extension: "extension",
  "mcp-tools": "mcp",
  "built-in-tools": "tools",
  environment: "env",
};

const usageStr = (u?: ContextUsageLike): string =>
  u && u.tokens !== null && u.percent !== null
    ? `${u.percent}% · ${comma(u.tokens)} / ${comma(u.contextWindow)} tok`
    : u
      ? `n/a (unknown until the next reply) / ${comma(u.contextWindow)} tok`
      : "n/a";

const share = (n: number, of: number): string => `${of > 0 ? Math.round((n / of) * 100) : 0}%`;

function shareBar(n: number, of: number, w: number): string {
  if (n <= 0 || of <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((Math.min(n, of) / of) * w)));
}

export function buildAuditDoc(items: LoadedItem[], summary: AuditSummary): Block[] {
  const total = summary.systemPromptTokens;
  const out: Block[] = [
    { kind: "h1", text: "Context audit" },
    {
      kind: "kv",
      cols: 2,
      pairs: [
        ["loaded items", comma(summary.itemCount)],
        ["system prompt", `~${comma(total)} tok`],
        ["context window", usageStr(summary.contextUsage)],
        ["attributed", `~${comma(summary.attributedTokens)} tok (${share(summary.attributedTokens, total)} of the prompt)`],
      ],
    },
  ];
  if (items.length === 0) {
    out.push({ kind: "gap" }, { kind: "text", text: "(no loaded items found)" });
    return out;
  }

  // Where the prompt goes, by type.
  const byType = new Map<string, { n: number; tok: number }>();
  for (const it of items) {
    const g = byType.get(TYPE_LABEL[it.kind]) ?? { n: 0, tok: 0 };
    g.n += 1;
    g.tok += it.injectedTokens;
    byType.set(TYPE_LABEL[it.kind], g);
  }
  const typeRows: [string, number, number][] = [...byType.entries()].map(([k, g]) => [k, g.n, g.tok]);
  const rest = total - summary.attributedTokens;
  if (rest > 0) typeRows.push(["(other)", 0, rest]);
  typeRows.sort((a, b) => b[2] - a[2]);
  out.push({ kind: "h2", text: "Prompt share by type" });
  out.push({
    kind: "table",
    head: ["type", "items", "tokens", "share", ""],
    right: [1, 2, 3],
    rows: typeRows.map(([k, n, tok]) => [k, n ? comma(n) : "", `~${comma(tok)}`, share(tok, total), shareBar(tok, total, 30)]),
  });
  if (rest > 0) out.push({ kind: "text", tone: "dim", text: "(other): prompt text no item accounts for — preamble, separators, untagged prose" });

  out.push({ kind: "h2", text: "Items (prompt order)" });
  out.push({ kind: "text", tone: "dim", text: "n/p jumps item by item below; / searches" });
  out.push({
    kind: "table",
    head: ["#", "type", "name", "tokens", "share", ""],
    right: [0, 3, 4],
    flex: 2,
    rows: items.map((it, i) => [String(i + 1), TYPE_LABEL[it.kind], it.label, `~${comma(it.injectedTokens)}`, share(it.injectedTokens, total), shareBar(it.injectedTokens, total, 12)]),
  });

  items.forEach((it, i) => {
    out.push({ kind: "h2", text: `[${i + 1}] ${TYPE_LABEL[it.kind]} — ${it.label}` });
    out.push({ kind: "text", tone: "dim", text: `~${comma(it.injectedTokens)} tok (${share(it.injectedTokens, total)})${it.note ? ` · ${it.note}` : ""}` });
    out.push({
      kind: "text",
      tone: "dim",
      text: it.path
        ? `source: ${it.path} (${it.diskBytes !== undefined ? `${fmtBytes(it.diskBytes)} on disk` : "missing on disk"})`
        : "source: built-in (no file)",
    });
    const { text, hidden } = capItemText(it.injectedText);
    out.push({ kind: "pre", text });
    if (hidden > 0) out.push({ kind: "text", tone: "dim", text: `… truncated: showing ${comma(text.length)} of ${comma(it.injectedChars)} chars` });
  });
  return out;
}

export function buildSummary(a: AuditData, items: LoadedItem[]): AuditSummary {
  return {
    itemCount: items.length,
    systemPromptTokens: a.totalTokens,
    attributedTokens: items.reduce((s, i) => s + i.injectedTokens, 0),
    contextUsage: a.contextUsage,
  };
}

/** Per-tag notes for the sections table; a host adds its own. */
export type SectionNotes = Record<string, (s: AuditSection) => string>;

export function renderAudit(a: AuditData, mode: "full" | "prompt" | "tools", host: Pick<Host, "sectionNotes" | "untaggedNote">): string {
  const out: string[] = [];
  if (mode === "full") out.push(`Content Audit · cwd=${a.cwd} · model=${a.model}`);
  const u = a.contextUsage;
  if (mode === "full" && u) {
    out.push(
      u.tokens !== null && u.percent !== null
        ? `Context: ${comma(u.tokens)} / ${comma(u.contextWindow)} (${u.percent}%)`
        : `Context: n/a (unknown until the next reply) / ${comma(u.contextWindow)}`,
    );
  }

  if (mode === "prompt" || mode === "full") {
    out.push(`Prompt parts: ${a.parts.length}   total ${comma(a.totalChars)} chars · ~${comma(a.totalTokens)} tok (est chars/4)`);
    a.parts.forEach((p, i) => {
      out.push(`  [${i}] ${comma(p.chars)} chars · ~${comma(p.tokens)} tok · ${comma(p.lines)} lines`);
    });
    if (mode === "prompt") return out.join("\n");
    out.push("");
    out.push("Sections (top-level, by injected size):");
    const maxTag = Math.max(...a.sections.map((s) => s.tag.length + 2), "untagged".length);
    for (const s of a.sections) {
      let line = `  <${s.tag}>${" ".repeat(maxTag - s.tag.length - 2)}  ${comma(s.chars)} c · ~${comma(s.tokens)} tok`;
      const note = host.sectionNotes[s.tag];
      if (note) line += ` · ${note(s)}`;
      out.push(line);
      if (s.files) {
        const maxPath = Math.max(...s.files.map((f) => f.path.length), 1);
        for (const f of s.files) {
          out.push(`      ${f.path.padEnd(maxPath)}  ${comma(f.chars)} c (${diskNote(f)})`);
        }
      }
    }
    out.push(`  untagged${" ".repeat(maxTag - "untagged".length)}  ${comma(a.untaggedChars)} c · ${host.untaggedNote}`);
  }

  if (mode === "full" || mode === "tools") {
    if (mode === "full") out.push("");
    out.push(`Tools (${a.tools.length}) — prompt footprint & provenance:`);
    if (a.tools.length > 0) {
      const maxName = Math.max(...a.tools.map((t) => t.name.length));
      const maxLoc = Math.max(...a.tools.map((t) => (t.path || (t.baseDir ? `baseDir=${t.baseDir}` : "—")).length));
      for (const t of [...a.tools].sort((x, y) => y.tokens - x.tokens)) {
        const loc = t.path || (t.baseDir ? `baseDir=${t.baseDir}` : "—");
        out.push(`  ${t.name.padEnd(maxName)}  ${t.source.padEnd(9)}  ${loc.padEnd(maxLoc)}  ~${comma(t.tokens)} tok`);
      }
    } else {
      out.push("  (none registered)");
    }
  }

  if (mode === "full") {
    out.push("");
    out.push(`On-disk skills (${a.skills.length}):`);
    if (a.skills.length > 0) {
      const maxName = Math.max(...a.skills.map((s) => s.name.length));
      const maxPath = Math.max(...a.skills.map((s) => s.dir.length));
      for (const s of a.skills) {
        out.push(`  ${s.name.padEnd(maxName)}  ${s.dir.padEnd(maxPath)}  ${fmtBytes(s.sizeBytes).padStart(9)}  [${s.loaded ? "loaded" : "not loaded"}]`);
      }
    } else {
      out.push("  (none found)");
    }
  }

  return out.join("\n");
}

export function auditHelp(): string {
  return [
    "usage: /content-audit [subcommand]",
    "",
    "  (none)         plan-style overlay: overview (item count, token",
    "                 totals), then per loaded item in load order the",
    "                 exact injected text and source file path;",
    "                 j/k ↑↓ PgUp/PgDn g G scroll · Esc/Enter close",
    "  help           this text",
    "  prompt         per-part size table only",
    "  prompt full    dump every prompt part verbatim (capped; may contain secrets)",
    "  section <tag>  dump the first top-level <tag> match's content",
    "  file <substr>  dump the context file whose path contains <substr>",
    "  tools          tools section only (prompt footprint & provenance)",
    "  json           structured JSON, no bodies (shareable)",
    "",
    "Prompt text is taken from ctx.getSystemPrompt() (the live effective prompt),",
    "never re-derived from disk. Token estimates use the chars/4 convention.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /content-audit
// ---------------------------------------------------------------------------

/** What an entry point supplies: its host's TUI pieces and how to read its prompt. */
export interface Host {
  ui: UiKit;
  /** Read the live prompt, tools and skills into AuditData. */
  collect(pi: any, ctx: any): AuditData;
  /** The ordered loaded items (prompt order) for the overlay. */
  items(pi: any, ctx: any, a: AuditData): Promise<LoadedItem[]>;
  sectionNotes: SectionNotes;
  /** What the text outside any top-level tag is, on this host. */
  untaggedNote: string;
}

/** The part of the host's extension API the core uses. */
export interface CommandApi {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
}

export async function contentAudit(pi: unknown, host: Host, args: string, ctx: ViewCtx): Promise<void> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = words[0] ?? "";

  if (sub === "help" || sub === "-h" || sub === "--help") {
    await present(auditHelp(), ctx);
    return;
  }

  const a = host.collect(pi, ctx);

  if (sub === "json") {
    const obj = {
      model: a.model,
      cwd: a.cwd,
      ...(a.contextUsage ? { contextUsage: a.contextUsage } : {}),
      parts: a.parts,
      sections: a.sections.map((s) => ({
        tag: s.tag,
        chars: s.chars,
        tokens: s.tokens,
        ...(s.files
          ? { files: s.files.map((f) => ({ path: f.path, chars: f.chars, ...(f.diskBytes !== undefined ? { diskBytes: f.diskBytes } : {}) })) }
          : {}),
      })),
      untaggedChars: a.untaggedChars,
      tools: a.tools,
      skills: a.skills.map((s) => ({ name: s.name, dir: s.dir, sizeBytes: s.sizeBytes, loaded: s.loaded })),
    };
    await present(JSON.stringify(obj, null, 2), ctx);
    return;
  }

  if (sub === "prompt") {
    const mode = words[1] ?? "";
    if (mode === "full") {
      const out: string[] = [
        "⚠ Prompt content may contain secrets (API keys, tokens, credentials). Do not share raw dumps.",
        "",
      ];
      a.rawParts.forEach((p, i) => {
        out.push(`──── part [${i}] (${comma(p.length)} chars) ────`);
        out.push(dumpCap(p));
        out.push("");
      });
      await present(out.join("\n"), ctx);
      return;
    }
    if (mode !== "") {
      await present(`unknown prompt mode "${mode}".\nusage: /content-audit prompt [full]`, ctx);
      return;
    }
    await present(renderAudit(a, "prompt", host), ctx);
    return;
  }

  if (sub === "section") {
    const tag = words[1];
    if (!tag) {
      await present("usage: /content-audit section <tag>\navailable top-level tags: " + a.sections.map((s) => s.tag).join(", "), ctx);
      return;
    }
    const m = a.tagMatches.find((x) => x.tag === tag.toLowerCase());
    if (!m) {
      await present(`no top-level <${tag}> match. available: ${a.sections.map((s) => s.tag).join(", ")}`, ctx);
      return;
    }
    await present(`──── <${tag}> (part ${m.partIdx}, ${comma(m.content.length)} content chars) ────\n${dumpCap(m.content)}`, ctx);
    return;
  }

  if (sub === "file") {
    const substr = (words[1] ?? "").toLowerCase();
    if (!substr) {
      await present(
        "usage: /content-audit file <substr>\navailable context file paths:\n" +
          (a.repoFiles.length ? a.repoFiles.map((f) => `  ${f.path}  (${comma(f.chars)} c)`).join("\n") : "  (none)"),
        ctx,
      );
      return;
    }
    const f = a.repoFiles.find((x) => x.path.toLowerCase().includes(substr));
    if (!f) {
      await present(
        `no context file path contains "${words[1]}". available:\n` +
          (a.repoFiles.length ? a.repoFiles.map((x) => `  ${x.path}`).join("\n") : "  (none)"),
        ctx,
      );
      return;
    }
    await present(`──── ${f.path} (${comma(f.chars)} c · ${diskNote(f)}) ────\n${dumpCap(f.content)}`, ctx);
    return;
  }

  if (sub === "tools") {
    await present(renderAudit(a, "tools", host), ctx);
    return;
  }

  if (sub !== "") {
    await present(`unknown subcommand "${sub}".\n\n${auditHelp()}`, ctx);
    return;
  }

  const items = await host.items(pi, ctx, a);
  await presentDoc(buildAuditDoc(items, buildSummary(a, items)), "Context Audit", host.ui, ctx);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(pi: CommandApi, host: Host): void {
  pi.registerCommand("content-audit", {
    description:
      "Plan-style context audit: overview (item count, token totals), then per loaded item in load order the exact injected text and source file path. Scroll: j/k ↑↓ PgUp/PgDn g G · Esc/Enter close. Subcommands: help, prompt [full], section <tag>, file <substr>, tools, json",
    handler: async (args, ctx) => {
      try {
        await contentAudit(pi, host, args, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        try {
          await present(`content-audit error: ${msg}`, ctx);
        } catch {
          console.log(msg);
        }
      }
    },
  });
}
