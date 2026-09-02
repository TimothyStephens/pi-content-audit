/**
 * omp-context-manager — OMP context audit extension (v1).
 *
 * Registers exactly one command:
 *   /content-audit — what feeds the agent (prompt parts, injected sections,
 *                    tool provenance, on-disk skills)
 *
 * Companion extension: omp-audit (/session-stats).
 * OMP 17.2.14. No tools, no hooks, no flags, no dashboard.
 */
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
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
  skillNames: Set<string>;
  tagMatches: { tag: string; partIdx: number; content: string }[];
  warnings: string[];
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
  try {
    for (const e of fs.readdirSync(plugins, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.add(path.join(plugins, e.name, "skills"));
    }
  } catch {
    /* no plugins dir */
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

  const warnings: string[] = [];
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
    skillNames,
    tagMatches,
    warnings,
  };
}

function diskNote(f: RepoFile): string {
  if (f.diskBytes === undefined) return "missing on disk";
  if (new TextEncoder().encode(f.content).length === f.diskBytes) return `disk ${comma(f.diskBytes)} B ✓`;
  return `≠ disk ${comma(f.diskBytes)} B`;
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

  for (const w of a.warnings) out.push(`⚠ ${w}`);
  return out.join("\n");
}

function auditHelp(): string {
  return [
    "usage: /content-audit [subcommand]",
    "",
    "  (none)         full report: prompt parts, injected sections, tool",
    "                 provenance, on-disk skills",
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
    if ((words[1] ?? "") === "full") {
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

  await present(renderAudit(a, "full"), ctx);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("content-audit", {
    description:
      "Audit what feeds the agent: prompt parts, injected sections, tool provenance, on-disk skills. Subcommands: help, prompt [full], section <tag>, file <substr>, tools, json",
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
