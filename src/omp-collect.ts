/**
 * pi-content-audit: OMP's collector (wired up in omp.ts).
 *
 * The system prompt arrives as parts carrying <skills>, <generic-rules>,
 * <domain-rules>, <workstation> and <repo-rules><file path=…> blocks; rule
 * source paths come from OMP's capability module (a dynamic import, so this
 * file loads without it). OMP 17.2.14+.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
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
  toolItems,
  toolRows,
} from "./core.ts";
import type { Host } from "./core.ts";

const SKILL_LINE = /^-\s+([A-Za-z0-9_.-]+):/;

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

export function collect(pi: ExtensionAPI, ctx: ExtensionCommandContext): AuditData {
  const parts: string[] = ctx.getSystemPrompt();
  const scan = scanPrompt(parts);

  const repoFiles: RepoFile[] = [];
  const skillNames = new Set<string>();
  for (const t of scan.tagMatches) {
    if (t.tag === "repo-rules") {
      // Nested <file> blocks are inside the outer match, so the top-level scan
      // never lists them — scan the repo-rules content directly.
      const fre = /<file[^>]*?path="([^"]*)"[^>]*>([\s\S]*?)<\/file>/g;
      let fm: RegExpExecArray | null;
      while ((fm = fre.exec(t.content))) {
        const p = fm[1];
        const resolved = path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
        repoFiles.push({ path: p, chars: fm[2].length, content: fm[2], diskBytes: diskSize(resolved) });
      }
    }
    if (t.tag === "skills") {
      for (const line of t.content.split("\n")) {
        const sm = line.match(SKILL_LINE);
        if (sm) skillNames.add(sm[1]);
      }
    }
  }

  // On-disk skills inventory (best effort)
  const skills: AuditData["skills"] = [];
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
      const sizeBytes = diskSize(skillMd);
      if (sizeBytes === undefined) continue; // no SKILL.md
      const key = `${e.name}\u0000${dir}`;
      if (seenSkill.has(key)) continue;
      seenSkill.add(key);
      skills.push({ name: e.name, dir: skillMd, sizeBytes, loaded: skillNames.has(e.name) });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    model: ctx.model?.id ?? "n/a",
    cwd: ctx.cwd,
    contextUsage: ctx.getContextUsage(),
    rawParts: parts,
    parts: scan.partStats,
    totalChars: scan.totalChars,
    totalTokens: Math.max(0, Math.ceil(scan.totalChars / 4)),
    sections: sectionsOf(scan, { filesTag: "repo-rules", files: repoFiles, skillsTag: "skills", skillCount: skillNames.size }),
    untaggedChars: scan.untaggedChars,
    tools: toolRows(pi.getAllTools()),
    skills,
    repoFiles,
    tagMatches: scan.tagMatches,
  };
}

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

/**
 * Ordered (prompt-order) list of loaded context items: skills → always-apply
 * rules → domain rules → extension/mcp/built-in tools → environment → context
 * files. Mirrors the order the model sees in ctx.getSystemPrompt() blocks.
 */
export async function items(pi: ExtensionAPI, ctx: ExtensionCommandContext, a: AuditData): Promise<LoadedItem[]> {
  const out: LoadedItem[] = [];
  const tag = (name: string) => a.tagMatches.find((t) => t.tag === name);

  // skill name → on-disk SKILL.md (from the same scan collect already ran)
  const skillFiles = new Map<string, string>();
  for (const s of a.skills) if (!skillFiles.has(s.name)) skillFiles.set(s.name, s.dir);

  const activeRules = await loadActiveRules();
  const ruleByName = new Map<string, ActiveRule>();
  if (activeRules) for (const r of activeRules) if (!ruleByName.has(r.name)) ruleByName.set(r.name, r);

  // 1. skills — block [0] <skills> (name+description lines)
  const skillsTag = tag("skills");
  if (skillsTag) {
    for (const line of skillsTag.content.split("\n")) {
      const sm = line.match(SKILL_LINE);
      if (!sm) continue;
      const md = skillFiles.get(sm[1]);
      out.push(
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
    out.push(
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
      out.push(
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
  out.push(...toolItems(pi.getAllTools(), "built-in (pi-coding-agent)"));

  // 5. environment — block [2] <workstation> (computed; no file)
  const wsTag = tag("workstation");
  if (wsTag)
    out.push(
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
    out.push(
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

  return out;
}

/** The host-specific report text the core asks for. */
export const notes: Pick<Host, "sectionNotes" | "untaggedNote"> = {
  sectionNotes: {
    skills: (s) => `${s.skillCount} skills (name+description only)`,
    "generic-rules": () => "full rule content",
    "domain-rules": () => "name+glob+description only",
    "repo-rules": (s) => `${s.files?.length ?? 0} file(s), full content`,
  },
  untaggedNote: "tool inventory, policies, xd:// devices, prose",
};
