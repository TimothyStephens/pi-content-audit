/**
 * pi-content-audit: Pi's collector (wired up in pi.ts).
 *
 * Pi builds its system prompt as one string of sections, in this order: an
 * untagged preamble, then <tools>, <rules>, <docs>, <addendum>,
 * <project_context>, <skills>, <cwd>, then any section an extension added
 * (Pi 1.5, core/system-prompt.js). ctx.getSystemPromptOptions() hands the
 * same inputs over as data, which gives the context files' paths and the
 * skills' files; every item's injected text is still cut from the live prompt.
 * Pi 1.5+.
 */
import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import {
  type AuditData,
  type LoadedItem,
  type RepoFile,
  diskNote,
  diskSize,
  mk,
  scanPrompt,
  sectionsOf,
  tokOfChars,
  toolRows,
} from "./core.ts";
import type { Host } from "./core.ts";

/** Sections Pi itself writes; anything else came from an extension. */
const OWN_SECTIONS = new Set(["tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `<skill>…</skill>` block naming `name` in Pi's <skills> section, or undefined if it is not listed. */
export function skillBlock(skillsSection: string, name: string): string | undefined {
  const re = new RegExp(`[ \\t]*<skill>\\s*<name>${escapeRe(escapeXml(name))}</name>[\\s\\S]*?</skill>`);
  return skillsSection.match(re)?.[0];
}

export function collect(pi: ExtensionAPI, ctx: ExtensionCommandContext): AuditData {
  const prompt = ctx.getSystemPrompt();
  const opts = ctx.getSystemPromptOptions();
  const scan = scanPrompt([prompt]);
  const skillsSection = scan.tagMatches.find((t) => t.tag === "skills")?.content ?? "";

  const repoFiles: RepoFile[] = (opts.contextFiles ?? []).map((f) => ({
    path: f.path,
    chars: f.content.length,
    content: f.content,
    diskBytes: diskSize(path.isAbsolute(f.path) ? f.path : path.resolve(ctx.cwd, f.path)),
  }));

  const skills: AuditData["skills"] = (opts.skills ?? [])
    .map((s) => ({
      name: s.name,
      dir: s.filePath,
      sizeBytes: diskSize(s.filePath) ?? 0,
      // Listed in the prompt; a disable-model-invocation skill is loaded but runs only as /skill:<name>.
      loaded: skillBlock(skillsSection, s.name) !== undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    model: ctx.model?.id ?? "n/a",
    cwd: ctx.cwd,
    contextUsage: ctx.getContextUsage(),
    rawParts: [prompt],
    parts: scan.partStats,
    totalChars: scan.totalChars,
    totalTokens: tokOfChars(scan.totalChars),
    sections: sectionsOf(scan, {
      filesTag: "project_context",
      files: repoFiles,
      skillsTag: "skills",
      skillCount: skills.filter((s) => s.loaded).length,
    }),
    untaggedChars: scan.untaggedChars,
    tools: toolRows(pi.getAllTools()),
    skills,
    repoFiles,
    tagMatches: scan.tagMatches,
  };
}

/** Group the `- name: snippet` lines of <tools> by who registered each tool. */
function toolListItems(toolsSection: string, tools: readonly ToolInfo[]): LoadedItem[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const groups = new Map<string, { kind: LoadedItem["kind"]; label: string; path?: string; lines: string[] }>();
  const unlisted: string[] = [];
  for (const line of toolsSection.split("\n")) {
    const m = line.match(/^- ([^:\s]+):/);
    if (!m) {
      if (line.trim()) unlisted.push(line);
      continue;
    }
    const src = byName.get(m[1])?.sourceInfo;
    const key = src?.source === "extension" ? `ext:${src.baseDir ?? src.path}` : src?.source === "mcp" ? "mcp" : "builtin";
    let g = groups.get(key);
    if (!g) {
      g =
        src?.source === "extension"
          ? { kind: "extension", label: path.basename(src.baseDir ?? src.path), path: src.baseDir ?? src.path, lines: [] }
          : key === "mcp"
            ? { kind: "mcp-tools", label: "MCP tools", lines: [] }
            : { kind: "built-in-tools", label: "built-in tools", lines: [] };
      groups.set(key, g);
    }
    g.lines.push(line);
  }
  const out = [...groups.values()].map((g) =>
    mk({
      kind: g.kind,
      label: g.label,
      path: g.path,
      injectedText: g.lines.join("\n"),
      note: `${g.lines.length} tool(s) listed in <tools>; full definitions go to the model beside the prompt`,
    }),
  );
  if (unlisted.length) out.push(mk({ kind: "tool-list", label: "<tools> footer", injectedText: unlisted.join("\n"), note: "built-in" }));
  return out;
}

/** Prompt order: tools → rules → docs → addendum → context files → skills → environment → extension sections. */
export async function items(pi: ExtensionAPI, ctx: ExtensionCommandContext, a: AuditData): Promise<LoadedItem[]> {
  const out: LoadedItem[] = [];
  const tag = (name: string) => a.tagMatches.find((t) => t.tag === name);

  const toolsTag = tag("tools");
  if (toolsTag) out.push(...toolListItems(toolsTag.content, pi.getAllTools()));

  const rulesTag = tag("rules");
  if (rulesTag)
    out.push(
      mk({
        kind: "guidelines",
        label: "guidelines",
        injectedText: rulesTag.content,
        note: "built-in rules, tool guidelines and extensions' promptGuidelines",
      }),
    );

  const docsTag = tag("docs");
  if (docsTag) out.push(mk({ kind: "section", label: "<docs>", injectedText: docsTag.content, note: "built-in pointer to Pi's own docs" }));

  const addTag = tag("addendum");
  if (addTag)
    out.push(
      mk({
        kind: "addendum",
        label: "appended system prompt",
        injectedText: addTag.content,
        note: "APPEND_SYSTEM.md, --append-system-prompt or an extension",
      }),
    );

  for (const f of a.repoFiles) {
    out.push(
      mk({
        kind: "context-file",
        label: f.path,
        path: path.isAbsolute(f.path) ? f.path : path.resolve(ctx.cwd, f.path),
        injectedText: f.content,
        note: diskNote(f),
        diskBytes: f.diskBytes,
      }),
    );
  }

  const skillsTag = tag("skills");
  if (skillsTag) {
    for (const s of a.skills) {
      const block = skillBlock(skillsTag.content, s.name);
      if (!block) continue; // not listed (disable-model-invocation)
      out.push(
        mk({
          kind: "skill",
          label: s.name,
          path: s.dir,
          injectedText: block,
          note: "name+description+location only in prompt; the model reads SKILL.md when it uses it",
          diskBytes: diskSize(s.dir),
        }),
      );
    }
  }

  const cwdTag = tag("cwd");
  if (cwdTag) out.push(mk({ kind: "environment", label: "environment", injectedText: cwdTag.content, note: "built-in (computed; not a file)" }));

  for (const t of a.tagMatches) {
    if (OWN_SECTIONS.has(t.tag)) continue;
    out.push(mk({ kind: "section", label: `<${t.tag}>`, injectedText: t.content, note: "added by an extension" }));
  }

  return out;
}

/** The host-specific report text the core asks for. */
export const notes: Pick<Host, "sectionNotes" | "untaggedNote"> = {
  sectionNotes: {
    tools: () => "one line per active tool",
    rules: () => "guidelines",
    skills: (s) => `${s.skillCount} skills (name+description+location only)`,
    project_context: (s) => `${s.files?.length ?? 0} file(s), full content`,
  },
  untaggedNote: "preamble (Pi's role line, or SYSTEM.md when set) and separators",
};
