# pi-content-audit

Context audit extension for [OMP](https://github.com/oh-my-pi/oh-my-pi). Answers: *what actually
feeds the agent in this session?* Registers exactly one command: `/content-audit`. No tools, no
hooks, no flags, no dashboard.

Prompt text is taken from `ctx.getSystemPrompt()` (the live effective prompt), never re-derived
from disk. Read-only.

Companion extension: [pi-session-stats](https://github.com/TimothyStephens/pi-session-stats)
(`/session-stats`).

## What it does

Prompt parts and their sizes, injected sections, tool provenance, and on-disk skills (repo
rules, skill dirs). Token estimates use the chars/4 convention (matches pi-devtools).

```
/content-audit [subcommand]
```

| Subcommand | Output |
| --- | --- |
| *(none)* | Plan-style overlay: overview (item count, token totals), then per item in load order the exact injected text (per-item injected text capped at 20,000 chars) and the source file path |
| `help` | This help text |
| `prompt` | Per-part size table only |
| `prompt full` | Every prompt part verbatim (capped; may contain secrets) |
| `section <tag>` | The first top-level `<tag>` match's content |
| `file <substr>` | The repo-rules file whose path contains `<substr>` (case-insensitive) |
| `tools` | Tools section only (prompt footprint & provenance) |
| `json` | Structured JSON, no bodies (shareable) |

## Install

1. **Via omp-env** (the default in this environment): provisioned by `./omp-env install` from
   the [omp-env](https://github.com/TimothyStephens/omp-env) repo's `manifest.json` — nothing to
   do.
2. **Development** (live reload):

   ```bash
   npm install
   omp plugin link /path/to/pi-content-audit
   ```

   Symlinks this repo into `~/.omp/plugins/node_modules`; edits reload on save. `npm install`
   is required so the extension's imports resolve locally.
3. **Snapshot**:

   ```bash
   omp install github:TimothyStephens/pi-content-audit
   ```

   Clones the repo and installs its dependencies into `~/.omp/plugins`.

## Requirements

OMP 17.2.14+ (`@oh-my-pi/pi-coding-agent`). Tool provenance uses `getAllTools(): ToolInfo[]`;
on versions where it returns strings, the `tools` view and the main view's tool items break
(the other subcommands still work).

## Notes

- Read-only: the extension never modifies prompts, files, or config.
- `prompt full` can contain secrets (API keys, tokens) — do not paste it into tickets or chats.
- Main-view overlay keys: j/k/arrows scroll, Shift+↑/↓ faster, PgUp/PgDn page, g/G jump,
  Esc/Enter close. Subcommand views keep the plain paged overlay (same pattern pi-session-stats
  uses); the repos are standalone on purpose.
