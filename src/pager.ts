/**
 * Read-only document viewer shared by the OMP and Pi entry points.
 *
 * Reports are built as a list of layout blocks (headings, wrapped text,
 * key–value runs, aligned tables, verbatim text) and laid out here, rather
 * than handed to the host's Markdown component. The two hosts' Markdown
 * renderers differ (Pi rules every table row and shows code fences), so
 * owning the layout gives one compact look under both, and gives the viewer
 * what it needs for section jumps and search.
 *
 * Nothing here imports a host package: the entry point passes the host's
 * width function in a `UiKit`, and the host passes its live theme to the
 * `ctx.ui.custom` factory.
 *
 * The same file is in pi-session-stats; the two repos stay standalone on purpose.
 */

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type Tone = "dim" | "accent" | "error" | "warning" | "success";

export type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  /** Word-wrapped paragraph. */
  | { kind: "text"; text: string; tone?: Tone }
  /** `label  value` lines, labels aligned; `cols` pairs per line when they fit. */
  | { kind: "kv"; pairs: readonly (readonly [string, string])[]; cols?: number }
  /** Aligned columns, one rule under the header. `flex` is the column cut to fit (default: widest). */
  | { kind: "table"; head: readonly string[]; rows: readonly (readonly string[])[]; right?: readonly number[]; flex?: number; tones?: readonly (Tone | undefined)[] }
  /** Verbatim lines, indented, wrapped at the width (at a space when there is one). */
  | { kind: "pre"; text: string }
  | { kind: "gap" };

/** The part of a host theme the viewer uses. Both hosts' Theme classes have these. */
export interface HostTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PLAIN: HostTheme = { fg: (_c, s) => s, bold: (s) => s };

/** What an entry point supplies from its host's packages. */
export interface UiKit {
  /** Terminal cell width of a string (wide characters count 2). */
  visibleWidth: (text: string) => number;
  /** Extra options for `ctx.ui.custom` (Pi sizes overlays from these; OMP ignores them). */
  overlayOptions?: Record<string, unknown>;
}

/** Fallback width: one cell per code point. Good enough for print mode. */
const codePointWidth = (s: string): number => [...s].length;

/** The part of a command context the viewer uses. Methods, so both hosts' contexts fit. */
export interface ViewCtx {
  hasUI: boolean;
  ui: {
    custom(
      factory: (tui: any, theme: any, keybindings: any, done: (result: any) => void) => any,
      options?: any,
    ): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);

/** Tabs to spaces, other control characters to visible symbols: injected text must not drive the terminal. */
export function sanitize(s: string): string {
  return s.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => (c === ESC ? "␛" : "�"));
}

interface Measure {
  w: (s: string) => number;
}

/** Cut to at most `width` cells, with "…" when anything was dropped. */
export function cut(s: string, width: number, m: Measure): string {
  if (m.w(s) <= width) return s;
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = m.w(ch);
    if (used + cw > width - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

const pad = (s: string, width: number, m: Measure, right = false): string => {
  const fill = " ".repeat(Math.max(0, width - m.w(s)));
  return right ? fill + s : s + fill;
};

/** Hard-wrap one line into pieces of at most `width` cells. */
function hardWrap(line: string, width: number, m: Measure): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let cur = "";
  let used = 0;
  for (const ch of line) {
    const cw = m.w(ch);
    if (used + cw > width) {
      out.push(cur);
      cur = "";
      used = 0;
    }
    cur += ch;
    used += cw;
  }
  out.push(cur);
  return out;
}

/**
 * Wrap verbatim text: break after the last space that fits, hard-break a run
 * with no space; spacing is kept as written.
 */
function softWrap(line: string, width: number, m: Measure): string[] {
  const out: string[] = [];
  let rest = line;
  while (m.w(rest) > width) {
    const pieces = hardWrap(rest, width, m);
    const head = pieces[0];
    const sp = head.lastIndexOf(" ");
    const take = sp > 0 && sp >= head.length / 3 ? sp + 1 : head.length;
    out.push(rest.slice(0, take).replace(/ +$/, ""));
    rest = rest.slice(take);
  }
  out.push(rest);
  return out;
}

/** Word-wrap at spaces; words longer than the width are hard-wrapped. */
function wordWrap(text: string, width: number, m: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/ +/)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (m.w(cand) <= width) {
        cur = cand;
        continue;
      }
      if (cur) out.push(cur);
      if (m.w(word) <= width) cur = word;
      else {
        const pieces = hardWrap(word, width, m);
        cur = pieces.pop() ?? "";
        out.push(...pieces);
      }
    }
    out.push(cur);
  }
  return out;
}

/** Column widths for a table at `width`, shrinking the flex column (then the widest others) to fit. */
function columnWidths(head: readonly string[], rows: readonly (readonly string[])[], width: number, flex: number | undefined, m: Measure): number[] {
  const n = head.length;
  const ws = head.map((h, i) => Math.max(m.w(h), ...rows.map((r) => m.w(r[i] ?? ""))));
  const gaps = 2 * (n - 1);
  let over = ws.reduce((s, x) => s + x, 0) + gaps - width;
  const order = [flex ?? ws.indexOf(Math.max(...ws)), ...ws.map((_, i) => i).sort((a, b) => ws[b] - ws[a])];
  for (const i of order) {
    if (over <= 0) break;
    const floor = Math.min(ws[i], Math.max(4, m.w(head[i])));
    const take = Math.min(over, ws[i] - floor);
    ws[i] -= take;
    over -= take;
  }
  return ws;
}

export interface Laid {
  /** Styled lines, each at most `width` cells. */
  lines: string[];
  /** The same lines without styling, for search and print mode. */
  plain: string[];
  /** Line indices of h1/h2 headings, for section jumps. */
  heads: number[];
}

/** Lay blocks out at `width`. Content is laid out plain, then styled line by line. */
export function layout(blocks: readonly Block[], width: number, measure: (s: string) => number, theme: HostTheme = PLAIN): Laid {
  const m: Measure = { w: measure };
  const lines: string[] = [];
  const plain: string[] = [];
  const heads: number[] = [];
  const push = (p: string, styled?: string) => {
    plain.push(p);
    lines.push(styled ?? p);
  };
  const blank = () => {
    if (plain.length && plain[plain.length - 1] !== "") push("");
  };
  const tone = (t: Tone | undefined, s: string) => (t ? theme.fg(t, s) : s);
  const w = Math.max(10, width);

  for (const b of blocks) {
    switch (b.kind) {
      case "h1": {
        const t = cut(sanitize(b.text), w, m);
        heads.push(plain.length);
        push(t, theme.bold(theme.fg("accent", t)));
        break;
      }
      case "h2": {
        blank();
        const t = cut(sanitize(b.text), w, m);
        heads.push(plain.length);
        push(t, theme.bold(t));
        break;
      }
      case "text":
        for (const l of wordWrap(sanitize(b.text), w, m)) push(l, tone(b.tone, l));
        break;
      case "gap":
        blank();
        break;
      case "pre":
        // Blank lines around the text are the prompt's separators, not content.
        for (const raw of sanitize(b.text).replace(/^\s*\n/, "").replace(/\n\s*$/, "").split("\n"))
          for (const l of softWrap(raw, w - 2, m)) push(`  ${l}`);
        break;
      case "kv": {
        const pairs = b.pairs.map(([k, v]) => [sanitize(k), sanitize(v)] as const);
        // Most pairs per line that fit, each column sized to its own widest label and value.
        let per = Math.max(1, b.cols ?? 1);
        let kws: number[] = [];
        let vws: number[] = [];
        for (; per >= 1; per--) {
          kws = Array.from({ length: per }, (_, c) => Math.max(0, ...pairs.filter((_, i) => i % per === c).map(([k]) => m.w(k))));
          vws = Array.from({ length: per }, (_, c) => Math.max(0, ...pairs.filter((_, i) => i % per === c).map(([, v]) => m.w(v))));
          const total = kws.reduce((s, k, c) => s + k + 2 + vws[c], 0) + 4 * (per - 1);
          if (per === 1 || total <= w) break;
        }
        for (let i = 0; i < pairs.length; i += per) {
          const ps: string[] = [];
          const ss: string[] = [];
          pairs.slice(i, i + per).forEach(([k, v], c, group) => {
            const val = c === group.length - 1 ? v : pad(v, vws[c], m);
            ps.push(`${pad(k, kws[c], m)}  ${val}`);
            ss.push(`${theme.fg("dim", pad(k, kws[c], m))}  ${val}`);
          });
          const p = ps.join("    ");
          if (m.w(p) > w) push(cut(p, w, m));
          else push(p, ss.join("    "));
        }
        break;
      }
      case "table": {
        const head = b.head.map(sanitize);
        const rows = b.rows.map((r) => r.map(sanitize));
        const ws = columnWidths(head, rows, w, b.flex, m);
        const right = new Set(b.right ?? []);
        const fmt = (r: readonly string[]) => r.map((c, i) => pad(cut(c ?? "", ws[i], m), ws[i], m, right.has(i))).join("  ").replace(/ +$/, "");
        const h = fmt(head);
        push(h, theme.fg("dim", h));
        const rule = ws.map((x) => "─".repeat(x)).join("  ");
        push(rule, theme.fg("dim", rule));
        rows.forEach((r, i) => {
          const l = fmt(r);
          push(l, tone(b.tones?.[i], l));
        });
        break;
      }
    }
  }
  while (plain.length && plain[plain.length - 1] === "") {
    plain.pop();
    lines.pop();
  }
  return { lines, plain, heads };
}

/** The document as plain text, for print / RPC mode. */
export function docText(blocks: readonly Block[], width = 120, measure: (s: string) => number = codePointWidth): string {
  return layout(blocks, width, measure).plain.join("\n");
}

// ---------------------------------------------------------------------------
// Keys and scrolling
// ---------------------------------------------------------------------------

export type ScrollAction =
  | "close"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "top"
  | "bottom"
  | "fastUp"
  | "fastDown"
  | "nextSection"
  | "prevSection"
  | "search";

/** Raw terminal input → action. Legacy and xterm-style sequences; kitty CSI-u for Esc/Enter. */
export function keyAction(data: string): ScrollAction | undefined {
  switch (data) {
    case ESC:
    case `${ESC}[27u`:
    case "\r":
    case "\n":
    case `${ESC}[13u`:
    case "q":
      return "close";
    case "j":
    case `${ESC}[B`:
    case `${ESC}OB`:
      return "down";
    case "k":
    case `${ESC}[A`:
    case `${ESC}OA`:
      return "up";
    case `${ESC}[1;2B`:
    case "J":
      return "fastDown";
    case `${ESC}[1;2A`:
    case "K":
      return "fastUp";
    case `${ESC}[5~`:
    case "b":
      return "pageUp";
    case `${ESC}[6~`:
    case " ":
      return "pageDown";
    case `${ESC}[H`:
    case `${ESC}OH`:
    case `${ESC}[1~`:
    case `${ESC}[7~`:
    case "g":
      return "top";
    case `${ESC}[F`:
    case `${ESC}OF`:
    case `${ESC}[4~`:
    case `${ESC}[8~`:
    case "G":
      return "bottom";
    case "n":
    case "]":
    case "\t":
      return "nextSection";
    case "p":
    case "[":
    case `${ESC}[Z`:
      return "prevSection";
    case "/":
      return "search";
    default:
      return undefined;
  }
}

/** New scroll offset for a movement, clamped so the last page stays full. */
export function scrollTo(offset: number, action: ScrollAction, total: number, viewport: number, heads: readonly number[] = []): number {
  const max = Math.max(0, total - viewport);
  const page = Math.max(1, viewport - 1);
  let next = offset;
  if (action === "down") next += 1;
  else if (action === "up") next -= 1;
  else if (action === "fastDown") next += 5;
  else if (action === "fastUp") next -= 5;
  else if (action === "pageDown") next += page;
  else if (action === "pageUp") next -= page;
  else if (action === "top") next = 0;
  else if (action === "bottom") next = max;
  else if (action === "nextSection") next = heads.find((h) => h > offset) ?? offset;
  else if (action === "prevSection") next = [...heads].reverse().find((h) => h < offset) ?? 0;
  return Math.max(0, Math.min(max, next));
}

/** Indices of lines containing `query`, case-insensitive. */
export function findLines(plain: readonly string[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  plain.forEach((l, i) => {
    if (l.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}

const isPrintable = (data: string) => data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data) && !data.startsWith(ESC);

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/**
 * Rounded box + title around the laid-out document; a footer with key hints
 * (or the search prompt) and the visible line range.
 *
 * Keys: j/k ↑↓ line, J/K Shift+↑↓ five lines, PgUp/PgDn (b/space) page,
 * g/G Home/End ends, n/p ]/[ Tab next/previous section, / search; after a
 * search n/N next/previous match and Esc clears it. Esc/Enter/q close.
 */
export class DocView {
  #blocks: readonly Block[];
  #kit: UiKit;
  #theme: HostTheme;
  #title: string;
  #rows: () => number;
  #done: () => void;
  #offset = 0;
  #viewport = 3;
  #laid: Laid = { lines: [], plain: [], heads: [] };
  #laidWidth = -1;
  /** Search prompt being typed, or null. */
  #typing: string | null = null;
  #query = "";
  #matches: number[] = [];
  #match = -1;

  constructor(blocks: readonly Block[], title: string, kit: UiKit, theme: HostTheme, rows: () => number, done: () => void) {
    this.#blocks = blocks;
    this.#kit = kit;
    this.#theme = theme;
    this.#title = title;
    this.#rows = rows;
    this.#done = done;
  }

  #m(): Measure {
    return { w: this.#kit.visibleWidth };
  }

  render(width: number): string[] {
    const t = this.#theme;
    const m = this.#m();
    const paint = (s: string) => t.fg("border", s);
    const inner = Math.max(1, width - 4);
    if (inner !== this.#laidWidth) {
      this.#laid = layout(this.#blocks, inner, this.#kit.visibleWidth, t);
      this.#laidWidth = inner;
      if (this.#query) this.#matches = findLines(this.#laid.plain, this.#query);
    }
    const { lines } = this.#laid;
    this.#viewport = Math.max(3, this.#rows() - 4); // 4 chrome rows
    this.#offset = Math.min(this.#offset, Math.max(0, lines.length - this.#viewport)); // after a resize
    const current = this.#match >= 0 ? this.#matches[this.#match] : -1;
    const body: string[] = [];
    for (let i = this.#offset; i < Math.min(lines.length, this.#offset + this.#viewport); i++) {
      const gutter = i === current ? t.fg("accent", "›") : " ";
      body.push(`${paint("│")}${gutter}${pad(lines[i], inner, m)} ${paint("│")}`);
    }

    const span = Math.max(0, width - 2);
    const title = cut(` ${this.#title} `, Math.max(0, span - 2), m);
    const fill = Math.max(0, span - 1 - m.w(title));
    const first = lines.length === 0 ? 0 : this.#offset + 1;
    const range = `${first}–${this.#offset + body.length}/${lines.length}`;
    let footer: string;
    if (this.#typing !== null) footer = `/${this.#typing}▏  Enter search · Esc cancel`;
    else if (this.#query)
      footer = this.#matches.length
        ? `“${this.#query}” ${this.#match + 1}/${this.#matches.length} · n/N match · Esc clear · ${range}`
        : `“${this.#query}” not found · Esc clear · ${range}`;
    else footer = `j/k scroll · PgUp/PgDn · n/p section · / search · Esc close · ${range}`;

    const out = [paint("╭─") + t.bold(t.fg("accent", title)) + paint("─".repeat(fill) + "╮")];
    out.push(...body);
    out.push(paint("├" + "─".repeat(span) + "┤"));
    out.push(`${paint("│")} ${pad(t.fg("dim", cut(footer, inner, m)), inner, m)} ${paint("│")}`);
    out.push(paint("╰" + "─".repeat(span) + "╯"));
    return out;
  }

  #jumpToMatch(): void {
    if (this.#match < 0) return;
    const line = this.#matches[this.#match];
    // Two lines of context above the match.
    this.#offset = Math.max(0, Math.min(line - 2, this.#laid.lines.length - this.#viewport));
  }

  handleInput(data: string): void {
    if (this.#typing !== null) {
      if (data === ESC || data === `${ESC}[27u`) this.#typing = null;
      else if (data === "\r" || data === "\n" || data === `${ESC}[13u`) {
        this.#query = this.#typing;
        this.#typing = null;
        this.#matches = findLines(this.#laid.plain, this.#query);
        this.#match = this.#matches.length ? Math.max(0, this.#matches.findIndex((l) => l >= this.#offset)) : -1;
        this.#jumpToMatch();
      } else if (data === "\x7f" || data === "\b") this.#typing = this.#typing.slice(0, -1);
      else if (isPrintable(data)) this.#typing += data;
      return;
    }
    if (this.#query && (data === ESC || data === `${ESC}[27u`)) {
      this.#query = "";
      this.#matches = [];
      this.#match = -1;
      return;
    }
    if (this.#query && this.#matches.length && (data === "n" || data === "N")) {
      const n = this.#matches.length;
      this.#match = (this.#match + (data === "n" ? 1 : n - 1)) % n;
      this.#jumpToMatch();
      return;
    }
    const a = keyAction(data);
    if (!a) return;
    if (a === "close") this.#done();
    else if (a === "search") this.#typing = "";
    else this.#offset = scrollTo(this.#offset, a, this.#laid.lines.length, this.#viewport, this.#laid.heads);
  }

  invalidate(): void {
    this.#laidWidth = -1;
  }
}

/** Plain pager over raw text (help, dumps): no layout, no theme. Also the fallback viewer. */
export async function present(text: string, ctx: ViewCtx): Promise<void> {
  if (!ctx.hasUI) {
    console.log(text); // print / RPC mode
    return;
  }
  const lines = sanitize(text).split("\n");
  await ctx.ui.custom((tui, _theme, _kb, done) => {
    let offset = 0;
    const viewport = () => Math.max(4, tui.terminal.rows - 3);
    return {
      render(_width: number): string[] {
        const v = lines.slice(offset, offset + viewport());
        return [...v, `${offset + 1}–${offset + v.length}/${lines.length} · Esc/Enter close · j/k ↑↓ PgUp PgDn g G`];
      },
      invalidate() {},
      handleInput(data: string): void {
        const a = keyAction(data);
        if (a === "close") done(undefined);
        else if (a) offset = scrollTo(offset, a, lines.length, viewport());
      },
    };
  }, { overlay: true });
}

/** The document in the boxed viewer; plain text without a UI; the plain pager if the viewer fails. */
export async function presentDoc(blocks: readonly Block[], title: string, kit: UiKit, ctx: ViewCtx): Promise<void> {
  if (!ctx.hasUI) {
    console.log(docText(blocks, 120, kit.visibleWidth));
    return;
  }
  try {
    await ctx.ui.custom((tui, hostTheme, _kb, done) => {
      return new DocView(blocks, title, kit, hostTheme as HostTheme, () => tui.terminal.rows, () => done(undefined));
    }, { overlay: true, ...(kit.overlayOptions ? { overlayOptions: kit.overlayOptions } : {}) });
  } catch {
    // The host's overlay wiring changed under us: same text, plain pager, no crash.
    await present(docText(blocks, 120, kit.visibleWidth), ctx);
  }
}
