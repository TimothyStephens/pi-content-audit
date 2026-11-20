/**
 * Read-only document viewer shared by the OMP and Pi entry points.
 *
 * Nothing here imports a host package: the entry point (omp.ts / pi.ts) passes
 * the host's own Markdown component and width helpers in a `UiKit`, and the
 * host passes its live theme to the `ctx.ui.custom` factory. That is what lets
 * one viewer run under both hosts, whose packages have different names
 * (`@oh-my-pi/*`, `@earendil-works/*`) and whose ScrollView APIs differ — so
 * scrolling is done here, over the rendered Markdown lines.
 *
 * The same file is in pi-session-stats; the two repos stay standalone on purpose.
 */

/** The part of a host theme the viewer uses. Both hosts' Theme classes have these. */
export interface HostTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface MarkdownLike {
  render(width: number): readonly string[];
  invalidate(): void;
}

/** What an entry point supplies from its host's packages. */
export interface UiKit {
  Markdown: new (text: string, paddingX: number, paddingY: number, theme: never) => MarkdownLike;
  getMarkdownTheme: () => unknown;
  truncateToWidth: (text: string, width: number) => string;
  visibleWidth: (text: string) => number;
  /** Called with the theme the host hands the overlay factory, before anything renders. */
  adoptTheme?: (hostTheme: unknown) => void;
  /** Extra options for `ctx.ui.custom` (Pi sizes overlays from these; OMP ignores them). */
  overlayOptions?: Record<string, unknown>;
}

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

const ESC = String.fromCharCode(27);

/** Rounded box drawing characters (the same glyphs both hosts use for overlays). */
const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", teeL: "┤", teeR: "├" };

export type ScrollAction = "close" | "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "fastUp" | "fastDown";

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
      return "fastDown";
    case `${ESC}[1;2A`:
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
    default:
      return undefined;
  }
}

/** New scroll offset for an action, clamped so the last page stays full. */
export function scrollTo(offset: number, action: ScrollAction, total: number, viewport: number): number {
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
  return Math.max(0, Math.min(max, next));
}

const HINT = "↑/↓ j/k scroll · PgUp/PgDn page · g/G jump · Esc/Enter close";

/**
 * Rounded box + title, the Markdown document scrolled inside it, a footer with
 * key hints and the visible line range.
 */
export class DocView {
  #md: MarkdownLike;
  #kit: UiKit;
  #theme: HostTheme;
  #title: string;
  #rows: () => number;
  #done: () => void;
  #offset = 0;
  #total = 0;
  #viewport = 3;

  constructor(doc: string, title: string, kit: UiKit, theme: HostTheme, rows: () => number, done: () => void) {
    this.#md = new kit.Markdown(doc, 1, 0, kit.getMarkdownTheme() as never);
    this.#kit = kit;
    this.#theme = theme;
    this.#title = title;
    this.#rows = rows;
    this.#done = done;
  }

  #fit(text: string, width: number): string {
    if (width <= 0) return "";
    const { truncateToWidth, visibleWidth } = this.#kit;
    const w = visibleWidth(text);
    if (w === width) return text;
    if (w < width) return text + " ".repeat(width - w);
    const cut = truncateToWidth(text, width);
    const cw = visibleWidth(cut);
    return cw < width ? cut + " ".repeat(width - cw) : cut;
  }

  render(width: number): string[] {
    const t = this.#theme;
    const paint = (s: string) => t.fg("border", s);
    const inner = Math.max(1, width - 4);
    const lines = this.#md.render(inner);
    this.#total = lines.length;
    this.#viewport = Math.max(3, this.#rows() - 4); // 4 chrome rows
    this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, this.#total - this.#viewport)));
    const body = lines.slice(this.#offset, this.#offset + this.#viewport);
    while (body.length < Math.min(this.#viewport, this.#total)) body.push("");

    const row = (s: string) => `${paint(BOX.v)} ${this.#fit(s, inner)} ${paint(BOX.v)}`;
    const span = Math.max(0, width - 2);
    const shown = this.#kit.truncateToWidth(` ${this.#title} `, Math.max(0, span - 2));
    const fill = Math.max(0, span - 1 - this.#kit.visibleWidth(shown));
    const first = this.#total === 0 ? 0 : this.#offset + 1;
    const range = `${first}–${this.#offset + body.length}/${this.#total}`;

    const out = [paint(BOX.tl + BOX.h) + t.bold(t.fg("accent", shown)) + paint(BOX.h.repeat(fill) + BOX.tr)];
    for (const l of body) out.push(row(l));
    out.push(paint(BOX.teeR + BOX.h.repeat(span) + BOX.teeL));
    out.push(row(t.fg("dim", `${HINT} · ${range}`)));
    out.push(paint(BOX.bl + BOX.h.repeat(span) + BOX.br));
    return out;
  }

  handleInput(data: string): void {
    const a = keyAction(data);
    if (!a) return;
    if (a === "close") {
      this.#done();
      return;
    }
    this.#offset = scrollTo(this.#offset, a, this.#total, this.#viewport);
  }

  invalidate(): void {
    this.#md.invalidate();
  }
}

/** Plain pager over raw text: no Markdown, no theme. The fallback, and the view for help/dumps. */
export async function present(text: string, ctx: ViewCtx): Promise<void> {
  if (!ctx.hasUI) {
    console.log(text); // print / RPC mode
    return;
  }
  const lines = text.split("\n");
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

/** The Markdown document in the boxed viewer; plain console output without a UI; the pager if the viewer fails. */
export async function presentDoc(doc: string, title: string, kit: UiKit, ctx: ViewCtx): Promise<void> {
  if (!ctx.hasUI) {
    console.log(doc);
    return;
  }
  try {
    await ctx.ui.custom((tui, hostTheme, _kb, done) => {
      kit.adoptTheme?.(hostTheme);
      return new DocView(doc, title, kit, hostTheme as HostTheme, () => tui.terminal.rows, () => done(undefined));
    }, { overlay: true, ...(kit.overlayOptions ? { overlayOptions: kit.overlayOptions } : {}) });
  } catch {
    // The host's theme or Markdown wiring changed under us: same text, plain pager, no crash.
    await present(doc, ctx);
  }
}
