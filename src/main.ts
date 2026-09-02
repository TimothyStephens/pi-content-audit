/**
 * omp-context-manager — OMP context audit extension (v1).
 *
 * Registers exactly one command:
 *   /content-audit — rich context manager: ordered list of loaded context
 *                    items (skills, rules, extensions, tools, environment,
 *                    context files) with exact injected text & source paths;
 *                    Enter open, e edit source, c copy path. Subcommands keep
 *                    the flat report (prompt, section, file, tools, json).
 *
 * Companion extension: omp-audit (/session-stats).
 * OMP 17.2.14. No tools, no hooks, no flags, no dashboard.
 */
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { getMarkdownTheme, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent";
import {
  type Component,
  type TUI,
  Ellipsis,
  Markdown,
  ScrollView,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const tok = (s: string) => Math.max(0, Math.ceil(s.length / 4)); // chars/4 convention (matches pi-devtools)
const tokOfChars = (n: number) => Math.max(0, Math.ceil(n / 4));
const DUMP_CAP = 200_000; // display cap for body dumps
const ESC = String.fromCharCode(27); // ESC for raw terminal key sequences

const comma = (n: number): string => n.toLocaleString("en-US");

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function dumpCap(text: string): string {
  if (text.length <= DUMP_CAP) return text;
  return `${text.slice(0, DUMP_CAP)}\n… truncated (${comma(text.length - DUMP_CAP)} more chars)`;
}

// ---------------------------------------------------------------------------
// Plan-style audit document: overview table + one section per loaded item.
// Pure function; also used verbatim as the no-UI (print/RPC) output.
// ---------------------------------------------------------------------------

const ITEM_TEXT_CAP = 20_000; // per-item display cap for injected text (chars)

const escapeMd = (s: string): string => s.replace(/([\\`*_\[\]|])/g, "\\$1");

/** Backtick fence longer than any backtick run in the text (min 3), so the
 *  injected text can never terminate its own code fence. No info string →
 *  no syntax highlighting; content renders verbatim. */
function fenceFor(text: string): string {
  let max = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > max) max = run;
    } else run = 0;
  }
  return "`".repeat(Math.max(3, max + 1));
}

function capItemText(t: string): { text: string; hidden: number } {
  if (t.length <= ITEM_TEXT_CAP) return { text: t, hidden: 0 };
  let cut = t.lastIndexOf("\n", ITEM_TEXT_CAP); // cut at a line boundary
  if (cut < ITEM_TEXT_CAP / 2) cut = ITEM_TEXT_CAP;
  return { text: t.slice(0, cut), hidden: t.length - cut };
}

function buildAuditDoc(items: LoadedItem[], summary: AuditSummary): string {
  const out: string[] = [
    "# Context audit",
    "",
    "| metric | value |",
    "| --- | --- |",
    `| loaded items | ${summary.itemCount} |`,
    `| system prompt | ~${comma(summary.systemPromptTokens)} tok |`,
    `| attributed to items | ~${comma(summary.attributedTokens)} tok |`,
    `| context window | ${
      summary.contextUsage
        ? `${summary.contextUsage.percent}% · ${comma(summary.contextUsage.tokens)} / ${comma(summary.contextUsage.contextWindow)} tok`
        : "n/a"
    } |`,
    "",
  ];
  if (items.length === 0) {
    out.push("(no loaded items found)");
    return out.join("\n");
  }
  out.push(
    "| # | type | name | location | size | tokens |",
    "| --- | --- | --- | --- | --- | --- |",
    ...items.map((it, i) =>
      `| ${i + 1} | ${escapeMd(it.kind)} | ${escapeMd(it.label)} | ${
        it.path ? escapeMd(it.path) : "—"
      } | ${it.diskBytes !== undefined ? fmtBytes(it.diskBytes) : "—"} | ~${comma(it.injectedTokens)} |`
    ),
    "",
  );
  items.forEach((it, i) => {
    out.push(`## [${i + 1}] ${it.kind} — ${escapeMd(it.label)}`);
    out.push(`~${comma(it.injectedTokens)} tok${it.note ? ` · ${it.note}` : ""}`);
    out.push(
      it.path
        ? `source: ${it.path.includes("`") ? escapeMd(it.path) : `\`${it.path}\``} (${
            it.diskBytes !== undefined ? `${fmtBytes(it.diskBytes)} on disk` : "missing on disk"
          })`
        : "source: built-in (no file)",
    );
    out.push("");
    const { text, hidden } = capItemText(it.injectedText);
    const fence = fenceFor(text);
    out.push(fence, text, fence);
    if (hidden > 0) out.push(`… truncated: showing ${comma(text.length)} of ${comma(it.injectedChars)} chars`);
    out.push("");
  });
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Rounded-box chrome (pattern: pi-coding-agent modes/components/overlay-box.ts)
// ---------------------------------------------------------------------------

const fitText = (text: string, width: number): string => {
  if (width <= 0) return "";
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + " ".repeat(width - w);
  const cut = truncateToWidth(text, width);
  const cw = visibleWidth(cut);
  return cw < width ? cut + " ".repeat(width - cw) : cut;
};

const borderPaint = (s: string): string => theme.fg("border", s);

function topBorder(width: number, title: string): string {
  const box = theme.boxRound;
  const inner = Math.max(0, width - 2);
  const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
  const fill = Math.max(0, inner - 1 - visibleWidth(shown));
  return (
    borderPaint(box.topLeft + box.horizontal) +
    theme.bold(theme.fg("accent", shown)) +
    borderPaint(box.horizontal.repeat(fill) + box.topRight)
  );
}

function rowBorder(content: string, width: number): string {
  const box = theme.boxRound;
  return `${borderPaint(box.vertical)} ${fitText(content, Math.max(0, width - 4))} ${borderPaint(box.vertical)}`;
}

function dividerLine(width: number): string {
  const box = theme.boxRound;
  return borderPaint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

function bottomBorder(width: number): string {
  const box = theme.boxRound;
  return borderPaint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/**
 * Plan-style overlay: rounded box + title, a ScrollView over the rendered
 * Markdown audit document, footer key hints. Keyboard: j/k/↑/↓ scroll,
 * Shift+↑/↓ scroll faster, PgUp/PgDn page, g/G (Home/End) jump, Esc/Enter close.
 */
class ContextAuditOverlay implements Component {
  #md: Markdown;
  #sv: ScrollView;
  #tui: TUI;
  #done: () => void;
  #lastLines: readonly string[] | null = null;
  #height = 0;

  constructor(doc: string, tui: TUI, done: () => void) {
    this.#md = new Markdown(doc, 1, 0, getMarkdownTheme());
    this.#sv = new ScrollView([], {
      height: 3,
      scrollbar: "auto",
      ellipsis: Ellipsis.Omit,
      theme: { track: (t: string) => theme.fg("dim", t), thumb: (t: string) => theme.fg("accent", t) },
    });
    this.#tui = tui;
    this.#done = done;
  }

  render(width: number): readonly string[] {
    const bodyH = Math.max(3, this.#tui.terminal.rows - 4); // 4 chrome rows
    if (bodyH !== this.#height) {
      this.#height = bodyH;
      this.#sv.setHeight(bodyH);
    }
    const innerW = Math.max(1, width - 4);
    const lines = this.#md.render(innerW);
    if (lines !== this.#lastLines) {
      this.#lastLines = lines;
      this.#sv.setLines(lines);
    }
    const body = this.#sv.render(innerW);
    const out: string[] = [topBorder(width, "Context Audit")];
    for (const line of body) out.push(rowBorder(line, width));
    out.push(dividerLine(width));
    out.push(rowBorder(theme.fg("dim", "↑/↓ j/k scroll · PgUp/PgDn page · g/G jump · Esc/Enter close"), width));
    out.push(bottomBorder(width));
    return out;
  }

  handleInput(data: string): void {
    if (data === ESC || data === "\r" || data === "\n") {
      this.#done();
      return;
    }
    if (this.#sv.handleScrollKey(data)) return;
    if (data === "j") this.#sv.scroll(1);
    else if (data === "k") this.#sv.scroll(-1);
    else if (data === "g") this.#sv.scrollToTop();
    else if (data === "G") this.#sv.scrollToBottom();
  }

  invalidate(): void {
    this.#md.invalidate();
  }
}

/** Paged read-only overlay: j/k/↑/↓ scroll, PgUp/PgDn, g/G, Esc/Enter close. */
async function present(text: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    console.log(text);
    return;
  } // OMP print/RPC mode — NOTE: `ctx.mode` does NOT exist in OMP
  const lines = text.split("\n");
  await ctx.ui.custom<void>(
    (tui, _theme, _kb, done) => {
      const rows: number = tui.terminal.rows;
      const viewport = Math.max(4, rows - 3);
      let offset = 0;
      const move = (d: number) => {
        offset = Math.max(0, Math.min(lines.length - 1, offset + d));
      };
      return {
        render(_width: number): readonly string[] {
          const v = lines.slice(offset, offset + viewport);
          const footer = `${offset + 1}–${offset + v.length}/${lines.length} · Esc/Enter close · jk ↑↓ PgUp PgDn g G`;
          return [...v, footer];
        },
        invalidate() {},
        handleInput(data: string): void {
          if (data === ESC || data === "\r" || data === "\n") {
            done();
            return;
          } else if (data === "j" || data === ESC + "[B") move(1);
          else if (data === "k" || data === ESC + "[A") move(-1);
          else if (data === ESC + "[5~" || data === ESC + "[~") offset = Math.max(0, offset - viewport); // PgUp
          else if (data === ESC + "[6~" || data === ESC + "[1~") offset = Math.min(lines.length - 1, offset + viewport); // PgDn
          else if (data === ESC + "[H" || data === "g") offset = 0; // Home
          else if (data === ESC + "[F" || data === "G") offset = Math.max(0, lines.length - viewport); // End
        },
      };
    },
    { overlay: true },
  );
}
/**
 * Plan-style overlay over the audit document (overview + per-item sections);
 * plain console mirror of the document in print/RPC mode (no UI).
 */
async function presentRich(items: LoadedItem[], summary: AuditSummary, ctx: ExtensionCommandContext): Promise<void> {
  const doc = buildAuditDoc(items, summary);
  if (!ctx.hasUI) {
    console.log(doc);
    return;
  }
  try {
    await ctx.ui.custom<void>((tui, hostTheme, _kb, done) => {
      // The extension's @oh-my-pi/pi-coding-agent import is a separate module
      // instance from the host's — its `theme` singleton is never initialized
      // (getSymbolTheme() guards the same cross-instance case, see #2998).
      // The host passes its live theme instance to the factory; install it so
      // getMarkdownTheme() and theme.fg render with the active theme.
      setThemeInstance(hostTheme);
      return new ContextAuditOverlay(doc, tui, () => done());
    }, {
      overlay: true,
    });
  } catch {
    // Contingency: if the overlay factory cannot run on this OMP version
    // (missing/changed theme wiring), degrade to the plain pager with the
    // same document text instead of crashing.
    await present(doc, ctx);
  }
}

// ---------------------------------------------------------------------------
// /content-audit
// ---------------------------------------------------------------------------

interface TagMatch {
  tag: string;
  start: number;
  end: number;
  chars: number;
  content: string;
}

interface RepoFile {
  path: string;
  chars: number; // inner injected content chars
  content: string;
  diskBytes?: number;
}

/** Generic top-level tag scan (no hard-coded tag list). */
function scanTags(text: string) {
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

interface AuditData {
  model: string;
  cwd: string;
  contextUsage?: ContextUsage;
  parts: { chars: number; tokens: number; lines: number }[];
  totalChars: number;
  totalTokens: number;
  sections: {
    tag: string;
    chars: number;
    tokens: number;
    files?: RepoFile[];
    skillCount?: number;
  }[];
  untaggedChars: number;
  tools: {
    name: string;
    source: string;
    path: string;
    scope: string;
    origin: string;
    baseDir: string;
    tokens: number;
  }[];
  skills: { name: string; dir: string; sizeBytes: number; loaded: boolean }[];
  repoFiles: RepoFile[];
  tagMatches: { tag: string; partIdx: number; content: string }[];
}
type ItemKind =
  | "context-file" // AGENT/CLAUDE context file (from <repo-rules> <file path=...>)
  | "skill" // a skill (- name: desc line; full SKILL.md on disk)
  | "generic-rule" // always-apply rule content (from <generic-rules>)
  | "domain-rule" // a domain rule (- name (globs): desc; full file on disk)
  | "extension" // one installed extension (its tools, grouped by sourceInfo.baseDir)
  | "mcp-tools" // MCP-provided tools (grouped)
  | "built-in-tools" // built-in/sdk tools (grouped into one item)
  | "environment"; // <workstation> block (built-in, no file)

interface LoadedItem {
  kind: ItemKind;
  label: string; // row text: file path | skill name | rule name | ext name | "environment"
  path?: string; // absolute source file path; undefined for built-ins
  injectedText: string; // EXACT text added to the prompt (verbatim sub-section)
  injectedChars: number;
  injectedTokens: number;
  note?: string; // e.g. "name+desc only; full content via skill://<name>"
  diskBytes?: number; // set when path exists on disk
}

interface AuditSummary {
  itemCount: number;
  systemPromptTokens: number; // sum tok(part) over ALL prompt parts (the true total)
  attributedTokens: number; // sum tok(item.injectedText) — the part explained by items
  contextUsage?: ContextUsage; // from ctx.getContextUsage()
}

function listSkillDirs(cwd: string): string[] {
  const home = os.homedir();
  const dirs = new Set<string>();
  dirs.add(path.join(home, ".omp/agent/skills"));
  dirs.add(path.join(home, ".omp/agent/managed-skills"));
  let d = cwd;
  for (;;) {
    dirs.add(path.join(d, ".omp/skills"));
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  const plugins = path.join(home, ".omp/plugins");
  for (const root of [plugins, path.join(plugins, "node_modules")]) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        // npm-linked plugin dirs are symlinks; the statSync below follows them
        if (e.isDirectory() || e.isSymbolicLink()) dirs.add(path.join(root, e.name, "skills"));
      }
    } catch {
      /* no plugins dir */
    }
  }
  const out: string[] = [];
  for (const dir of dirs) {
    try {
      if (fs.statSync(dir).isDirectory()) out.push(dir);
    } catch {
      /* missing */
    }
  }
  return out;
}

function buildAudit(pi: ExtensionAPI, ctx: ExtensionCommandContext): AuditData {
  const parts: string[] = ctx.getSystemPrompt();
  const partStats = parts.map((p) => ({ chars: p.length, tokens: tok(p), lines: p ? p.split("\n").length : 0 }));
  const totalChars = partStats.reduce((s, p) => s + p.chars, 0);

  const tagAgg = new Map<string, { chars: number; parts: number }>();
  const tagMatches: { tag: string; partIdx: number; content: string }[] = [];
  const repoFiles: RepoFile[] = [];
  const skillNames = new Set<string>();
  let untaggedChars = 0;

  parts.forEach((part, partIdx) => {
    const { top, all, untagged } = scanTags(part);
    untaggedChars += untagged;
    for (const t of top) {
      const a = tagAgg.get(t.tag) ?? { chars: 0, parts: 0 };
      a.chars += t.chars;
      a.parts += 1;
      tagAgg.set(t.tag, a);
      tagMatches.push({ tag: t.tag, partIdx, content: t.content });
      if (t.tag === "repo-rules") {
        // Nested <file> blocks are consumed by the outer regex match, so
        // `all` never contains them — scan the repo-rules span directly.
        const fre = /<file[^>]*?path="([^"]*)"[^>]*>([\s\S]*?)<\/file>/g;
        let fm: RegExpExecArray | null;
        while ((fm = fre.exec(part.slice(t.start, t.end)))) {
          const p = fm[1];
          const resolved = path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
          let diskBytes: number | undefined;
          try {
            diskBytes = fs.statSync(resolved).size;
          } catch {
            /* missing on disk */
          }
          repoFiles.push({ path: p, chars: fm[2].length, content: fm[2], diskBytes });
        }
      }
      if (t.tag === "skills") {
        for (const line of t.content.split("\n")) {
          const sm = line.match(/^-\s+([A-Za-z0-9_.-]+):/);
          if (sm) skillNames.add(sm[1]);
        }
      }
    }
  });

  // Tool provenance
  const tools = pi.getAllTools().map((t) => ({
    name: t.name,
    source: t.sourceInfo?.source ?? "?",
    path: t.sourceInfo?.path ?? "",
    scope: t.sourceInfo?.scope ?? "",
    origin: t.sourceInfo?.origin ?? "",
    baseDir: t.sourceInfo?.baseDir ?? "",
    tokens: tok(t.name + "\n" + (t.description ?? "") + "\n" + (t.promptGuidelines ?? []).join("\n")),
  }));

  // On-disk skills inventory (best effort)
  const skills: { name: string; dir: string; sizeBytes: number; loaded: boolean }[] = [];
  const seenSkill = new Set<string>();
  for (const dir of listSkillDirs(ctx.cwd)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = path.join(dir, e.name, "SKILL.md");
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(skillMd).size;
      } catch {
        continue; // no SKILL.md
      }
      const key = `${e.name}\u0000${dir}`;
      if (seenSkill.has(key)) continue;
      seenSkill.add(key);
      skills.push({ name: e.name, dir: skillMd, sizeBytes, loaded: skillNames.has(e.name) });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const sections = [...tagAgg.entries()]
    .map(([tag, a]) => ({
      tag,
      chars: a.chars,
      tokens: tokOfChars(a.chars),
      files: tag === "repo-rules" ? repoFiles : undefined,
      skillCount: tag === "skills" ? skillNames.size : undefined,
    }))
    .sort((a, b) => b.chars - a.chars);

  return {
    model: ctx.model?.id ?? "n/a",
    cwd: ctx.cwd,
    contextUsage: ctx.getContextUsage(),
    parts: partStats,
    totalChars,
    totalTokens: tokOfChars(totalChars),
    sections,
    untaggedChars,
    tools,
    skills,
    repoFiles,
    tagMatches,
  };
}

function diskNote(f: RepoFile): string {
  if (f.diskBytes === undefined) return "missing on disk";
  if (new TextEncoder().encode(f.content).length === f.diskBytes) return `disk ${comma(f.diskBytes)} B ✓`;
  return `≠ disk ${comma(f.diskBytes)} B`;
}
// ---------------------------------------------------------------------------
// Rich view: ordered loaded items (list → detail) + source-file affordances
// ---------------------------------------------------------------------------

interface ActiveRule {
  name: string;
  path: string;
  content?: string;
  alwaysApply?: boolean;
  globs?: string[];
  description?: string;
}

/**
 * The capability sub-path is internal and may be absent on older OMP versions,
 * so a static import would crash extension loading; the dynamic import + null
 * fallback keeps the extension working (rules then render prompt-only, no paths).
 */
async function loadActiveRules(): Promise<readonly ActiveRule[] | null> {
  try {
    const mod = await import("@oh-my-pi/pi-coding-agent/capability/rule");
    if (typeof mod.getActiveRules === "function") return mod.getActiveRules();
  } catch {
    /* older OMP / sub-path removed */
  }
  return null;
}

const diskSize = (p: string): number | undefined => {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
};

const mk = (it: Omit<LoadedItem, "injectedChars" | "injectedTokens">): LoadedItem => ({
  ...it,
  injectedChars: it.injectedText.length,
  injectedTokens: tok(it.injectedText),
});

/**
 * Ordered (prompt-order) list of loaded context items: skills → always-apply
 * rules → domain rules → extension/mcp/built-in tools → environment → context
 * files. Mirrors the order the model sees in ctx.getSystemPrompt() blocks.
 */
async function buildItems(pi: ExtensionAPI, ctx: ExtensionCommandContext, a: AuditData): Promise<LoadedItem[]> {
  const items: LoadedItem[] = [];
  const tag = (name: string) => a.tagMatches.find((t) => t.tag === name);

  // skill name → on-disk SKILL.md (from the same scan buildAudit already ran)
  const skillFiles = new Map<string, string>();
  for (const s of a.skills) if (!skillFiles.has(s.name)) skillFiles.set(s.name, s.dir);

  const activeRules = await loadActiveRules();
  const ruleByName = new Map<string, ActiveRule>();
  if (activeRules) for (const r of activeRules) if (!ruleByName.has(r.name)) ruleByName.set(r.name, r);

  // 1. skills — block [0] <skills> (name+description lines)
  const skillsTag = tag("skills");
  if (skillsTag) {
    for (const line of skillsTag.content.split("\n")) {
      const sm = line.match(/^-\s+([A-Za-z0-9_.-]+):/);
      if (!sm) continue;
      const md = skillFiles.get(sm[1]);
      items.push(
        mk({
          kind: "skill",
          label: sm[1],
          path: md,
          injectedText: line,
          note: "name+description only in prompt; full content via skill://<name>",
          diskBytes: md ? diskSize(md) : undefined,
        }),
      );
    }
  }

  // 2. always-apply rules — block [0] <generic-rules> (full content, one item)
  const genTag = tag("generic-rules");
  if (genTag) {
    const always = activeRules?.filter((r) => r.alwaysApply) ?? [];
    items.push(
      mk({
        kind: "generic-rule",
        label: "always-apply rules",
        path: always[0]?.path,
        injectedText: genTag.content,
        diskBytes: always[0] ? diskSize(always[0].path) : undefined,
        note: always.length
          ? `full always-apply rule content; per-rule detail: ${always.map((r) => `rule://${r.name}`).join(", ")}`
          : "full always-apply rule content; see rule:// for per-rule detail",
      }),
    );
  }

  // 3. domain rules — block [0] <domain-rules> (name+glob+description lines)
  const domTag = tag("domain-rules");
  if (domTag) {
    for (const line of domTag.content.split("\n")) {
      const dm = line.match(/^-\s+([A-Za-z0-9_.-]+)\s*\(/);
      if (!dm) continue;
      const rule = ruleByName.get(dm[1]);
      items.push(
        mk({
          kind: "domain-rule",
          label: dm[1],
          path: rule?.path,
          injectedText: line,
          diskBytes: rule ? diskSize(rule.path) : undefined,
          note: "name+description only in prompt; full rule via rule://<name>",
        }),
      );
    }
  }

  // 4. tools → extension / mcp / built-in groups — block [0] Tool Inventory
  const footprint = (t: ToolInfo): string =>
    t.promptGuidelines && t.promptGuidelines.length
      ? `${t.name}: ${t.description ?? ""}\n${t.promptGuidelines.join("\n")}`
      : `${t.name}: ${t.description ?? ""}`;
  const extGroups = new Map<string, ToolInfo[]>();
  const mcpTools: ToolInfo[] = [];
  const builtinTools: ToolInfo[] = [];
  for (const t of pi.getAllTools()) {
    const src = t.sourceInfo?.source;
    if (src === "extension") {
      const key = t.sourceInfo?.baseDir ?? t.sourceInfo?.path ?? "?";
      const g = extGroups.get(key) ?? [];
      g.push(t);
      extGroups.set(key, g);
    } else if (src === "mcp") mcpTools.push(t);
    else builtinTools.push(t); // builtin, sdk, unknown
  }
  for (const [key, tools] of extGroups) {
    const baseDir = tools[0].sourceInfo?.baseDir;
    items.push(
      mk({
        kind: "extension",
        label: baseDir ? path.basename(baseDir) : key,
        path: baseDir,
        injectedText: tools.map(footprint).join("\n"),
        note: `${tools.length} tool(s)`,
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
        note: `${builtinTools.length} tool(s); built-in (pi-coding-agent)`,
      }),
    );

  // 5. environment — block [2] <workstation> (computed; no file)
  const wsTag = tag("workstation");
  if (wsTag)
    items.push(
      mk({
        kind: "environment",
        label: "environment",
        injectedText: wsTag.content,
        note: "built-in (computed; not a file)",
      }),
    );

  // 6. context files — block [2] <repo-rules> <file path="…"> (full content)
  for (const f of a.repoFiles) {
    const resolved = path.isAbsolute(f.path) ? f.path : path.resolve(ctx.cwd, f.path);
    items.push(
      mk({
        kind: "context-file",
        label: f.path,
        path: resolved,
        injectedText: f.content,
        note: diskNote(f),
        diskBytes: f.diskBytes,
      }),
    );
  }

  return items;
}

function buildSummary(a: AuditData, items: LoadedItem[]): AuditSummary {
  return {
    itemCount: items.length,
    systemPromptTokens: a.totalTokens,
    attributedTokens: items.reduce((s, i) => s + i.injectedTokens, 0),
    contextUsage: a.contextUsage,
  };
}

function renderAudit(a: AuditData, mode: "full" | "prompt" | "tools"): string {
  const out: string[] = [];
  if (mode === "full") out.push(`Content Audit · cwd=${a.cwd} · model=${a.model}`);
  if (mode === "full" && a.contextUsage) {
    out.push(`Context: ${comma(a.contextUsage.tokens)} / ${comma(a.contextUsage.contextWindow)} (${a.contextUsage.percent}%)`);
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
      if (s.tag === "skills") line += ` · ${s.skillCount} skills (name+description only)`;
      else if (s.tag === "generic-rules") line += ` · full rule content`;
      else if (s.tag === "domain-rules") line += ` · name+glob+description only`;
      else if (s.tag === "repo-rules") line += ` · ${s.files?.length ?? 0} file(s), full content`;
      out.push(line);
      if (s.tag === "repo-rules" && s.files) {
        const maxPath = Math.max(...s.files.map((f) => f.path.length), 1);
        for (const f of s.files) {
          out.push(`      ${f.path.padEnd(maxPath)}  ${comma(f.chars)} c (${diskNote(f)})`);
        }
      }
    }
    out.push(`  untagged${" ".repeat(maxTag - "untagged".length)}  ${comma(a.untaggedChars)} c · tool inventory, policies, xd:// devices, prose`);
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

function auditHelp(): string {
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
    "  file <substr>  dump the repo-rules file whose path contains <substr>",
    "  tools          tools section only (prompt footprint & provenance)",
    "  json           structured JSON, no bodies (shareable)",
    "",
    "Prompt text is taken from ctx.getSystemPrompt() (the live effective prompt),",
    "never re-derived from disk. Token estimates use the chars/4 convention.",
  ].join("\n");
}

async function contentAudit(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = words[0] ?? "";

  if (sub === "help" || sub === "-h" || sub === "--help") {
    await present(auditHelp(), ctx);
    return;
  }

  const a = buildAudit(pi, ctx);

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
      const parts: string[] = ctx.getSystemPrompt();
      parts.forEach((p, i) => {
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
    await present(renderAudit(a, "prompt"), ctx);
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
        "usage: /content-audit file <substr>\navailable repo-rules paths:\n" +
          (a.repoFiles.length ? a.repoFiles.map((f) => `  ${f.path}  (${comma(f.chars)} c)`).join("\n") : "  (none)"),
        ctx,
      );
      return;
    }
    const f = a.repoFiles.find((x) => x.path.toLowerCase().includes(substr));
    if (!f) {
      await present(
        `no repo-rules file path contains "${words[1]}". available:\n` +
          (a.repoFiles.length ? a.repoFiles.map((x) => `  ${x.path}`).join("\n") : "  (none)"),
        ctx,
      );
      return;
    }
    await present(`──── ${f.path} (${comma(f.chars)} c · ${diskNote(f)}) ────\n${dumpCap(f.content)}`, ctx);
    return;
  }

  if (sub === "tools") {
    await present(renderAudit(a, "tools"), ctx);
    return;
  }

  if (sub !== "") {
    await present(`unknown subcommand "${sub}".\n\n${auditHelp()}`, ctx);
    return;
  }

  const items = await buildItems(pi, ctx, a);
  const summary = buildSummary(a, items);
  await presentRich(items, summary, ctx);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("content-audit", {
    description:
      "Plan-style context audit: overview (item count, token totals), then per loaded item in load order the exact injected text and source file path. Scroll: j/k ↑↓ PgUp/PgDn g G · Esc/Enter close. Subcommands: help, prompt [full], section <tag>, file <substr>, tools, json",
    handler: async (args, ctx) => {
      try {
        await contentAudit(pi, args, ctx);
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
