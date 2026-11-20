# pi-content-audit

Context audit extension for [OMP](https://github.com/can1357/oh-my-pi) and
[Pi](https://github.com/earendil-works/pi). Answers: *what actually
feeds the agent in this session?* Registers exactly one command: `/content-audit`. No tools, no
hooks, no flags, no dashboard.

Prompt text is taken from `ctx.getSystemPrompt()` (the live effective prompt), never re-derived
from disk. Read-only.

Companion extension: [pi-session-stats](https://github.com/TimothyStephens/pi-session-stats)
(`/session-stats`).

## What it does

Prompt parts and their sizes, injected sections, tool provenance, and skills. Token estimates
use the chars/4 convention (matches pi-devtools).

The two hosts build their prompts differently, so the items differ:

| | OMP | Pi |
| --- | --- | --- |
| Prompt | several parts | one string of `<section>` blocks |
| Skills | `<skills>` name+description lines; on-disk inventory from the OMP skill dirs | each `<skill>` block of `<skills>`; inventory from `ctx.getSystemPromptOptions().skills` (a `disable-model-invocation` skill shows as not loaded) |
| Rules | `<generic-rules>`, `<domain-rules>`, paths from OMP's rule capability | `<rules>` (guidelines); Pi has no rule files |
| Context files | `<repo-rules>` `<file path=…>` | `<project_context>` `<project_instructions path=…>` |
| Tools | tool footprint (name, description, guidelines) grouped by extension | each `<tools>` line, grouped by the extension that registered the tool |
| Other | `<workstation>` | `<docs>`, `<addendum>`, `<cwd>`, and any section an extension added |

```
/content-audit [subcommand]
```

| Subcommand | Output |
| --- | --- |
| *(none)* | Overview: totals (items, prompt and attributed tokens, context window), the prompt's share by item type (plus what no item accounts for), one row per item in prompt order with its share, then each item's exact injected text (capped at 20,000 chars) and source file |
| `help` | This help text |
| `prompt` | Per-part size table only |
| `prompt full` | Every prompt part verbatim (capped; may contain secrets) |
| `section <tag>` | The first top-level `<tag>` match's content |
| `file <substr>` | The context file whose path contains `<substr>` (case-insensitive) |
| `tools` | Tools section only (prompt footprint & provenance) |
| `json` | Structured JSON, no bodies (shareable) |

## Install

### OMP

1. **Via omp-env** (the default in this environment): provisioned by `./omp-env install` from
   the [omp-env](https://github.com/TimothyStephens/omp-env) repo's `manifest.json` — nothing to
   do.
2. **Development** (live reload):

   ```bash
   omp plugin link /path/to/pi-content-audit
   ```

   Symlinks this repo into `~/.omp/plugins/node_modules`; edits reload on save. Nothing needs
   installing: OMP resolves the `@oh-my-pi/*` imports to its own bundled copy.
3. **Snapshot**:

   ```bash
   omp install github:TimothyStephens/pi-content-audit
   ```

   Clones the repo into `~/.omp/plugins`.

### Pi

```bash
pi install git:github.com/TimothyStephens/pi-content-audit
```

or, from a checkout, `pi install ./pi-content-audit`. Pi maps the `@earendil-works/*` imports to
its own modules, so nothing needs installing.

Both hosts provide the packages this extension imports, so `package.json` lists them as optional
`peerDependencies` and an install fetches nothing. (As `dependencies` they made every install
download OMP, and agentbox's Pi install was killed for memory doing it.)

### agentbox

A `[[repo]]` entry in the OMP and Pi profiles' `plugins.toml`, at a pinned commit.

## Layout

| File | What |
| --- | --- |
| `src/core.ts` | the report, subcommands and registration; imports no host package |
| `src/pager.ts` | report layout and the viewer (the same file is in pi-session-stats) |
| `src/omp-collect.ts`, `src/omp.ts` | OMP's collector and wiring (the `omp` manifest entry) |
| `src/pi-collect.ts`, `src/pi.ts` | Pi's collector and wiring (the `pi` manifest entry) |

`package.json` declares both manifests. OMP reads `omp` before `pi`, and Pi reads only `pi`, so
each host loads its own entry point.

## Tests

```bash
npm test
```

`node --test`, no dependencies (Node 22.18+ runs the TypeScript directly). The Pi collector is
tested on `test/fixtures/pi-prompt.json`, a prompt built by Pi 1.5.2's own `buildSystemPrompt`;
`test/fixtures/gen-pi-prompt.mjs` regenerates it.

## Requirements

OMP 17.2.14+ (`@oh-my-pi/pi-coding-agent`), or Pi 1.5+ (`@earendil-works/pi-coding-agent`; the
Pi collector needs `ctx.getSystemPromptOptions()`). Tool provenance uses
`getAllTools(): ToolInfo[]`; on OMP versions where it returns strings, the `tools` view and the
main view's tool items break (the other subcommands still work).

## Notes

- Read-only: the extension never modifies prompts, files, or config.
- `prompt full` can contain secrets (API keys, tokens) — do not paste it into tickets or chats.
- Viewer keys: j/k/arrows scroll, J/K or Shift+↑/↓ five lines, PgUp/PgDn (b/space) page, g/G
  or Home/End jump, n/p (also ]/[ and Tab/Shift+Tab) item by item, `/` to search (type, Enter,
  then n/N between matches, Esc to clear). Esc/Enter/q close. Subcommand views keep the plain
  pager.
- The overview is laid out by the extension itself (aligned columns, injected text indented
  verbatim, no Markdown), so it looks the same in OMP and Pi; control characters in injected
  text are shown as symbols, never sent to the terminal. The viewer (`src/pager.ts`) is the
  same file in pi-session-stats; the repos are standalone on purpose.
