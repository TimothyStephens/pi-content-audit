# pi-content-audit

Context audit extension for [OMP](https://github.com/oh-my-pi/oh-my-pi).
Registers exactly one command: `/content-audit`. No tools, no hooks, no flags, no dashboard.

Companion extension: [pi-session-stats](https://github.com/TimothyStephens/pi-session-stats) (`/session-stats`).

## What it does

`/content-audit` answers: *what actually feeds the agent in this session?* — prompt parts and their sizes, injected sections, tool provenance, and on-disk skills (repo rules, skill dirs).

Prompt text is taken from `ctx.getSystemPrompt()` (the live effective prompt), never re-derived from disk. Token estimates use the chars/4 convention (matches pi-devtools).

**Usage:**

```
/content-audit [subcommand]
```

| Subcommand | Output |
| --- | --- |
| *(none)* | Plan-style overlay: overview (item count, token totals), then per item in load order the exact injected text and the source file path |
| `help` | This help text |
| `prompt` | Per-part size table only |
| `prompt full` | Every prompt part verbatim (capped; may contain secrets) |
| `section <tag>` | The first top-level `<tag>` match's content |
| `file <substr>` | The repo-rules file whose path contains `<substr>` |
| `tools` | Tools section only (prompt footprint & provenance) |
| `json` | Structured JSON, no bodies (shareable) |

## Install

Live / development (edits reload on save):

```bash
omp plugin link /path/to/pi-content-audit
```

Snapshot install:

```bash
omp install github:TimothyStephens/pi-content-audit
```

Requires OMP 17.2.14+ (`@oh-my-pi/pi-coding-agent`) — the tools-provenance section uses `getAllTools(): ToolInfo[]`, which returns strings on older versions and breaks every report mode.

## Notes

- Read-only: the extension never modifies prompts, files, or config.
- `prompt full` can contain secrets (API keys, tokens) — do not paste it into tickets or chats.
- The main view is a plan-style Markdown overlay (rounded box, title, scrollbar): j/k/↑/↓ scroll, Shift+↑/↓ faster, PgUp/PgDn page, g/G jump, Esc/Enter close. Subcommand views keep the plain paged overlay (same pattern pi-session-stats uses); the repos are standalone on purpose.
