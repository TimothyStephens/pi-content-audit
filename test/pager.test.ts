// Tests for the viewer shared by the OMP and Pi entry points, with a fake UiKit
// standing in for the host's Markdown component. Same file in pi-session-stats.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DocView, type UiKit, keyAction, present, presentDoc, scrollTo } from "../src/pager.ts";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const width = (s: string) => [...s.replace(ANSI, "")].length;

/** Markdown stand-in: one output line per input line, cut to the width. */
class FakeMarkdown {
  #text: string;
  constructor(text: string) {
    this.#text = text;
  }
  render(w: number): string[] {
    return this.#text.split("\n").map((l) => [...l].slice(0, w).join(""));
  }
  invalidate() {}
}

const kit: UiKit = {
  Markdown: FakeMarkdown as unknown as UiKit["Markdown"],
  getMarkdownTheme: () => ({}),
  truncateToWidth: (s, w) => [...s.replace(ANSI, "")].slice(0, w).join(""),
  visibleWidth: width,
};
const theme = { fg: (c: string, s: string) => `${ESC}[3${c.length % 8}m${s}${ESC}[0m`, bold: (s: string) => s };

const doc = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

test("every rendered line is exactly the width, chrome included", () => {
  const v = new DocView(doc, "Session Stats", kit, theme, () => 14, () => {});
  for (const w of [20, 37, 80]) {
    const out = v.render(w);
    assert.equal(out.length, 14, "body fills rows - 4, plus 4 chrome rows");
    for (const l of out) assert.equal(width(l), w, JSON.stringify(l));
  }
});

test("scrolling moves through the document and stops at both ends", () => {
  let closed = false;
  const v = new DocView(doc, "T", kit, theme, () => 14, () => (closed = true));
  const body = () => v.render(40).slice(1, 11).map((l) => l.replace(ANSI, "").slice(1, -1).trim());
  assert.equal(body()[0], "line 1");
  v.handleInput("j");
  assert.equal(body()[0], "line 2");
  v.handleInput(`${ESC}[6~`); // PgDn: a page less one line of overlap
  assert.equal(body()[0], "line 11");
  v.handleInput("G");
  assert.equal(body()[9], "line 50", "End shows the last line at the bottom");
  v.handleInput("j");
  assert.equal(body()[9], "line 50", "no scrolling past the end");
  v.handleInput("g");
  assert.equal(body()[0], "line 1");
  v.handleInput("k");
  assert.equal(body()[0], "line 1", "no scrolling before the start");
  assert.match(v.render(80).at(-2)!, /1–10\/50/);
  assert.equal(closed, false);
  v.handleInput(ESC);
  assert.equal(closed, true);
});

test("keys: legacy and xterm sequences map to the same actions", () => {
  assert.equal(keyAction(`${ESC}[A`), "up");
  assert.equal(keyAction(`${ESC}OA`), "up");
  assert.equal(keyAction(`${ESC}[1~`), "top", "Home, not page down");
  assert.equal(keyAction(`${ESC}[4~`), "bottom");
  assert.equal(keyAction(`${ESC}[5~`), "pageUp");
  assert.equal(keyAction("\r"), "close");
  assert.equal(keyAction(`${ESC}[27u`), "close", "kitty Esc");
  assert.equal(keyAction("x"), undefined);
  assert.equal(scrollTo(0, "bottom", 5, 10), 0, "a short document never scrolls");
});

test("no UI: both views print the text instead", async () => {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (s: string) => printed.push(s);
  try {
    const ctx = { hasUI: false, ui: { custom: async () => assert.fail("no overlay without a UI") } };
    await present("plain", ctx);
    await presentDoc("# doc", "T", kit, ctx);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(printed, ["plain", "# doc"]);
});

test("with a UI: the host theme reaches adoptTheme and the overlay options pass through", async () => {
  let adopted: unknown;
  let options: any;
  let view: any;
  const ctx = {
    hasUI: true,
    ui: {
      custom: async (factory: any, opts: any) => {
        options = opts;
        view = factory({ terminal: { rows: 10 } }, theme, {}, () => {});
      },
    },
  };
  await presentDoc(doc, "T", { ...kit, adoptTheme: (t) => (adopted = t), overlayOptions: { width: "100%" } }, ctx);
  assert.equal(adopted, theme);
  assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%" } });
  assert.ok(view instanceof DocView);
});

test("with a UI: a viewer that throws falls back to the plain pager", async () => {
  const calls: any[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      custom: async (factory: any) => {
        calls.push(factory);
        if (calls.length === 1) throw new Error("theme wiring changed");
        const pager = factory({ terminal: { rows: 10 } }, theme, {}, () => {});
        assert.match(pager.render(40).at(-1), /1–7\/50/);
      },
    },
  };
  await presentDoc(doc, "T", kit, ctx);
  assert.equal(calls.length, 2);
});
