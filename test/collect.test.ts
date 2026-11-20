// Tests for both collectors and the command, with fake host objects. The Pi
// prompt is fixtures/pi-prompt.json, built by Pi 1.5.2's own buildSystemPrompt
// (fixtures/gen-pi-prompt.mjs). Run: npm test (node --test, no dependencies).
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { type Host, buildAuditDoc, buildSummary, register } from "../src/core.ts";
import { docText } from "../src/pager.ts";
import * as ompCollect from "../src/omp-collect.ts";
import * as piCollect from "../src/pi-collect.ts";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/pi-prompt.json", import.meta.url), "utf8"));
const PROMPT: string = fixture.prompt;

const builtin = (name: string) => ({ name, description: `${name} tool`, sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" } });
const PI_TOOLS = [
  ...["read", "bash", "edit", "write"].map(builtin),
  {
    name: "session_note",
    description: "Write a note",
    promptGuidelines: ["Use session_note sparingly"],
    sourceInfo: { source: "extension", path: "/home/u/.pi/packages/npm/pi-notes/index.ts", scope: "user", origin: "package", baseDir: "/home/u/.pi/packages/npm/pi-notes" },
  },
];

const piApi = { getAllTools: () => PI_TOOLS };
const piCtx = {
  cwd: "/work/proj",
  model: { id: "local-model" },
  getSystemPrompt: () => PROMPT,
  getSystemPromptOptions: () => fixture.options,
  getContextUsage: () => ({ tokens: null, contextWindow: 131072, percent: null }),
};

test("Pi: sections, context files and skills come out of the real prompt", () => {
  const a = piCollect.collect(piApi as never, piCtx as never);
  assert.deepEqual(a.rawParts, [PROMPT]);
  assert.deepEqual(
    a.tagMatches.map((t) => t.tag),
    ["tools", "rules", "docs", "addendum", "project_context", "skills", "cwd", "team_notes"],
  );
  assert.deepEqual(a.repoFiles.map((f) => f.path), ["/work/proj/AGENTS.md", "/home/u/.pi/agent/AGENTS.md"]);
  assert.equal(a.sections.find((s) => s.tag === "project_context")?.files?.length, 2);
  assert.deepEqual(
    a.skills.map((s) => [s.name, s.loaded]),
    [["learn-repo", true], ["show-me", false], ["systematic-debugging", true]],
    "a disable-model-invocation skill is loaded but not listed",
  );
  assert.equal(a.sections.find((s) => s.tag === "skills")?.skillCount, 2);
  assert.equal(a.totalChars, PROMPT.length);
  assert.equal(a.tools.find((t) => t.name === "session_note")?.baseDir, "/home/u/.pi/packages/npm/pi-notes");
});

test("Pi: items in prompt order, each one's text cut verbatim from the prompt", async () => {
  const a = piCollect.collect(piApi as never, piCtx as never);
  const items = await piCollect.items(piApi as never, piCtx as never, a);
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.label}`),
    [
      "built-in-tools:built-in tools",
      "extension:pi-notes",
      "tool-list:<tools> footer",
      "guidelines:guidelines",
      "docs:<docs>",
      "addendum:appended system prompt",
      "context-file:/work/proj/AGENTS.md",
      "context-file:/home/u/.pi/agent/AGENTS.md",
      "skill:learn-repo",
      "skill:systematic-debugging",
      "environment:environment",
      "section:<team_notes>",
    ],
  );
  for (const it of items) assert.ok(PROMPT.includes(it.injectedText), `${it.label}: not verbatim in the prompt`);
  assert.equal(items[1].injectedText, "- session_note: Write a note into the session");
  assert.equal(items[0].injectedText.split("\n").length, 4);
  const learn = items.find((i) => i.label === "learn-repo")!;
  assert.match(learn.injectedText, /&lt;before&gt; a task &amp; take notes/, "the XML-escaped description is matched");
  assert.equal(learn.path, "/home/u/.pi/packages/git/agentbox-skills/skills/learn-repo/SKILL.md");
  assert.equal(items.find((i) => i.kind === "environment")?.injectedText.trim(), "/work/proj");
});

test("Pi: the overview: totals, share by type, one row per item, then each item verbatim", async () => {
  const a = piCollect.collect(piApi as never, piCtx as never);
  const items = await piCollect.items(piApi as never, piCtx as never, a);
  const doc = docText(buildAuditDoc(items, buildSummary(a, items)));
  assert.match(doc, /loaded items +12 /);
  assert.match(doc, /context window +n\/a \(unknown until the next reply\) \/ 131,072 tok/);
  assert.match(doc, /attributed +~\d+ tok \(\d+% of the prompt\)/);
  const types = doc.slice(doc.indexOf("Prompt share by type"), doc.indexOf("Items (prompt order)"));
  const typeRows = types.split("\n").slice(3).filter((l) => /~\d/.test(l)).map((l) => l.split(/ +/)[0]);
  assert.equal(typeRows[0], "docs", "the largest share first: Pi's own docs pointer");
  assert.ok(typeRows.includes("(other)"), "unattributed prompt text is its own row");
  assert.match(doc, /^ 9  skill +learn-repo +~56 +\d+% +█+$/m);
  assert.match(doc, /^\[9\] skill — learn-repo$/m);
  assert.match(doc, /^ {6}<name>learn-repo<\/name>$/m, "injected text verbatim (its own 4-space indent kept), indented 2, no fences");
  assert.doesNotMatch(doc, /```/);
  assert.doesNotMatch(doc, /\bcu\nrrent/, "verbatim prose breaks at spaces");
});

test("Pi: skillBlock finds only a listed skill, and treats the name literally", () => {
  const skills = PROMPT.slice(PROMPT.indexOf("<skills>"), PROMPT.indexOf("</skills>"));
  assert.ok(piCollect.skillBlock(skills, "learn-repo")?.includes("<location>"));
  assert.equal(piCollect.skillBlock(skills, "show-me"), undefined);
  assert.equal(piCollect.skillBlock(skills, "learn.repo"), undefined);
});

// --- OMP ---------------------------------------------------------------------

function ompFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pca-"));
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Repo rules here.");
  const parts = [
    "<skills>\n- learn-repo: Learn a repo\n- show-me: Explain\n</skills>\n<generic-rules>Always run tests.</generic-rules>\n<domain-rules>\n- python (*.py): Python rule\n</domain-rules>",
    "Tool inventory: bash, read",
    `<workstation>os: linux</workstation>\n<repo-rules>\n<file path="AGENTS.md">Repo rules here.</file>\n<file path="gone.md">old</file>\n</repo-rules>`,
  ];
  const ctx = {
    cwd,
    model: { id: "omp-model" },
    getSystemPrompt: () => parts,
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
  };
  const api = { getAllTools: () => [builtin("bash"), builtin("read")] };
  return { cwd, parts, ctx, api };
}

test("OMP: parts, repo-rules files and skills, as before the split", async () => {
  const { parts, ctx, api } = ompFixture();
  const a = ompCollect.collect(api as never, ctx as never);
  assert.deepEqual(a.rawParts, parts);
  assert.equal(a.parts.length, 3);
  assert.deepEqual(a.repoFiles.map((f) => [f.path, f.diskBytes]), [["AGENTS.md", 16], ["gone.md", undefined]]);
  assert.equal(a.sections.find((s) => s.tag === "repo-rules")?.files?.length, 2);
  assert.equal(a.sections.find((s) => s.tag === "skills")?.skillCount, 2);

  // No OMP here, so the capability import fails and rules render prompt-only: the documented fallback.
  const items = await ompCollect.items(api as never, ctx as never, a);
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.label}`),
    [
      "skill:learn-repo",
      "skill:show-me",
      "generic-rule:always-apply rules",
      "domain-rule:python",
      "built-in-tools:built-in tools",
      "environment:environment",
      "context-file:AGENTS.md",
      "context-file:gone.md",
    ],
  );
  const joined = parts.join("\n");
  for (const it of items.filter((i) => i.kind !== "built-in-tools")) assert.ok(joined.includes(it.injectedText), it.label);
  assert.equal(items.find((i) => i.label === "AGENTS.md")?.note, "disk 16 B ✓");
  assert.equal(items.find((i) => i.label === "gone.md")?.note, "missing on disk");
});

// --- the command -------------------------------------------------------------

async function run(host: Host, ctx: object, args: string): Promise<string> {
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  register({ registerCommand: (_n, o) => (handler = o.handler) }, host);
  const printed: string[] = [];
  const orig = console.log;
  console.log = (s: string) => printed.push(s);
  try {
    await handler(args, { ...ctx, hasUI: false, ui: { custom: async () => undefined } });
  } finally {
    console.log = orig;
  }
  return printed.join("\n");
}

const piHost: Host = {
  ui: {} as Host["ui"],
  collect: () => piCollect.collect(piApi as never, piCtx as never),
  items: (_p, _c, a) => piCollect.items(piApi as never, piCtx as never, a),
  ...piCollect.notes,
};

test("subcommands on Pi: section, file, prompt, json, full report", async () => {
  assert.match(await run(piHost, piCtx, "section team_notes"), /Notes an extension added\./);
  assert.match(await run(piHost, piCtx, "file proj/agents"), /# Project rules\nRun the tests\./);
  assert.match(await run(piHost, piCtx, "file nothing"), /no context file path contains "nothing"/);
  const full = await run(piHost, piCtx, "prompt full");
  assert.ok(full.includes(PROMPT), "prompt full dumps the prompt verbatim");
  assert.match(await run(piHost, piCtx, "prompt"), /Prompt parts: 1 /);
  const json = JSON.parse(await run(piHost, piCtx, "json"));
  assert.equal(json.skills.length, 3);
  assert.ok(json.sections.some((s: { tag: string; files?: unknown[] }) => s.tag === "project_context" && s.files?.length === 2));
  const report = await run(piHost, piCtx, "");
  assert.match(report, /^Context audit\n/);
  assert.match(await run(piHost, piCtx, "bogus"), /unknown subcommand "bogus"/);
});

test("the flat report's Context line keeps OMP's format, and says n/a when Pi does not know yet", async () => {
  const { ctx, api } = ompFixture();
  const ompHost: Host = {
    ui: {} as Host["ui"],
    collect: () => ompCollect.collect(api as never, ctx as never),
    items: (_p, _c, a) => ompCollect.items(api as never, ctx as never, a),
    ...ompCollect.notes,
  };
  const { renderAudit } = await import("../src/core.ts");
  const omp = renderAudit(ompCollect.collect(api as never, ctx as never), "full", ompHost);
  assert.match(omp, /^Context: 5,000 \/ 200,000 \(2\.5%\)$/m);
  assert.match(omp, /<repo-rules> +\d+ c · ~\d+ tok · 2 file\(s\), full content/);
  assert.match(omp, /untagged +\d+ c · tool inventory, policies, xd:\/\/ devices, prose/);
  const pi = renderAudit(piCollect.collect(piApi as never, piCtx as never), "full", piHost);
  assert.match(pi, /^Context: n\/a \(unknown until the next reply\) \/ 131,072$/m);
  assert.match(pi, /<project_context> +\d+ c · ~\d+ tok · 2 file\(s\), full content/);
});
