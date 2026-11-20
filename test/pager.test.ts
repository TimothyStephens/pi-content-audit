// Tests for the layout and viewer shared by the OMP and Pi entry points.
// Same file in pi-session-stats.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Block, DocView, type UiKit, docText, keyAction, layout, present, presentDoc, sanitize, scrollTo } from "../src/pager.ts";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** Cell width: wide East Asian characters count 2, as both hosts' visibleWidth does. */
const cells = (s: string) => [...s.replace(ANSI, "")].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0);

const kit: UiKit = { visibleWidth: cells };
const theme = { fg: (c: string, s: string) => `${ESC}[3${c.length % 8}m${s}${ESC}[0m`, bold: (s: string) => `${ESC}[1m${s}${ESC}[0m` };

/** 5 sections of 10 lines each. */
const doc: Block[] = [{ kind: "h1", text: "Title" }];
for (let s = 1; s <= 5; s++) {
  doc.push({ kind: "h2", text: `Section ${s}` });
  for (let i = 1; i <= 10; i++) doc.push({ kind: "text", text: `s${s} line ${i}${s === 4 && i === 7 ? " needle" : ""}` });
}

test("layout: kv pairs share a line when they fit, each column aligned", () => {
  const kv: Block = { kind: "kv", cols: 2, pairs: [["a", "1"], ["long label", "22"], ["bb", "333"], ["c", "4"]] };
  assert.deepEqual(layout([kv], 80, cells).plain, ["a   1      long label  22", "bb  333    c           4"]);
  assert.deepEqual(layout([kv], 20, cells).plain, ["a           1", "long label  22", "bb          333", "c           4"], "one per line when two do not fit");
});

test("layout: tables align, right-align numbers, and cut the flex column to fit", () => {
  const t: Block = { kind: "table", head: ["#", "name", "n"], right: [0, 2], flex: 1, rows: [["1", "a very long name indeed", "5"], ["10", "short", "1234"]] };
  assert.deepEqual(layout([t], 80, cells).plain, [
    " #  name                        n",
    "──  ───────────────────────  ────",
    " 1  a very long name indeed     5",
    "10  short                    1234",
  ]);
  const narrow = layout([t], 20, cells).plain;
  for (const l of narrow) assert.ok(cells(l) <= 20, l);
  assert.equal(narrow[2], " 1  a very lo…     5");
});

test("layout: pre keeps text verbatim and indented, wraps at a space (hard only without one), drops surrounding blank lines", () => {
  const out = layout([{ kind: "pre", text: "\n  keep  spacing\n" + "x".repeat(25) + "\nab  cd\n\n" }], 12, cells).plain;
  assert.deepEqual(out, ["    keep", "  spacing", "  xxxxxxxxxx", "  xxxxxxxxxx", "  xxxxx", "  ab  cd"]);
});

test("layout: text wraps at words; wide characters are measured in cells", () => {
  assert.deepEqual(layout([{ kind: "text", text: "one two three four" }], 10, cells).plain, ["one two", "three four"]);
  const wide = layout([{ kind: "table", head: ["名前", "n"], rows: [["日本語テキスト", "1"]] }], 80, cells).plain;
  assert.equal(cells(wide[0]), cells(wide[2]), "columns line up with double-width text");
  assert.equal(wide[2], "日本語テキスト  1");
});

test("layout: control characters in content cannot reach the terminal", () => {
  assert.equal(sanitize(`a${ESC}[2Jb\tc\u0007`), "a␛[2Jb    c�");
  assert.ok(!docText([{ kind: "pre", text: `x${ESC}]0;title\u0007` }]).includes(ESC));
});

test("viewer: every line is exactly the width, chrome included", () => {
  const v = new DocView(doc, "Session Stats", kit, theme, () => 14, () => {});
  for (const w of [20, 37, 80]) {
    const out = v.render(w);
    assert.equal(out.length, 14, "body fills rows - 4, plus 4 chrome rows");
    for (const l of out) assert.equal(cells(l), w, JSON.stringify(l));
  }
});

const body = (v: DocView) => v.render(40).slice(1, 11).map((l) => l.replace(ANSI, "").slice(2, -1).trim());

test("viewer: scrolling stops at both ends; Esc closes", () => {
  let closed = false;
  const v = new DocView(doc, "T", kit, theme, () => 14, () => (closed = true));
  assert.equal(body(v)[0], "Title");
  v.handleInput("j");
  v.handleInput("j");
  assert.equal(body(v)[0], "Section 1", "a blank line sits before each section heading");
  v.handleInput("G");
  assert.equal(body(v)[9], "s5 line 10", "End shows the last line at the bottom");
  v.handleInput("j");
  assert.equal(body(v)[9], "s5 line 10");
  v.handleInput("g");
  v.handleInput("k");
  assert.equal(body(v)[0], "Title");
  assert.equal(closed, false);
  v.handleInput(ESC);
  assert.equal(closed, true);
});

test("viewer: n/p jump between sections", () => {
  const v = new DocView(doc, "T", kit, theme, () => 14, () => {});
  v.render(40);
  v.handleInput("n");
  assert.equal(body(v)[0], "Section 1");
  v.handleInput("n");
  v.handleInput("n");
  assert.equal(body(v)[0], "Section 3");
  v.handleInput("p");
  assert.equal(body(v)[0], "Section 2");
  v.handleInput("]");
  assert.equal(body(v)[0], "Section 3");
});

test("viewer: / searches, n/N cycle matches, Esc clears the search before closing", () => {
  let closed = false;
  const v = new DocView(doc, "T", kit, theme, () => 14, () => (closed = true));
  v.render(40);
  for (const k of ["/", "l", "i", "n", "e", " ", "7"]) v.handleInput(k);
  assert.match(v.render(80).at(-2)!, /\/line 7/, "the prompt shows what is typed");
  v.handleInput("\r");
  assert.equal(closed, false, "Enter runs the search, it does not close");
  assert.match(v.render(80).at(-2)!, /“line 7” 1\/5/);
  const marked = () => v.render(40).find((l) => l.replace(ANSI, "").startsWith("│›"))?.replace(ANSI, "");
  assert.match(marked()!, /s1 line 7/);
  v.handleInput("n");
  assert.match(marked()!, /s2 line 7/);
  v.handleInput("N");
  v.handleInput("N");
  assert.match(marked()!, /s5 line 7/, "N wraps backwards");
  v.handleInput(ESC);
  assert.equal(closed, false);
  assert.doesNotMatch(v.render(80).at(-2)!, /line 7/);
  for (const k of ["/", "z", "z", "\x7f", "q", "\r"]) v.handleInput(k);
  assert.match(v.render(80).at(-2)!, /“zq” not found/, "Backspace edits the query");
  v.handleInput(ESC);
  v.handleInput(ESC);
  assert.equal(closed, true);
});

test("keys: legacy and xterm sequences map to the same actions", () => {
  assert.equal(keyAction(`${ESC}[A`), "up");
  assert.equal(keyAction(`${ESC}OA`), "up");
  assert.equal(keyAction(`${ESC}[1~`), "top", "Home, not page down");
  assert.equal(keyAction(`${ESC}[4~`), "bottom");
  assert.equal(keyAction("\t"), "nextSection");
  assert.equal(keyAction(`${ESC}[Z`), "prevSection");
  assert.equal(keyAction(`${ESC}[27u`), "close", "kitty Esc");
  assert.equal(keyAction("x"), undefined);
  assert.equal(scrollTo(0, "bottom", 5, 10), 0, "a short document never scrolls");
});

test("no UI: the document prints as plain text, no escapes", async () => {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (s: string) => printed.push(s);
  try {
    const ctx = { hasUI: false, ui: { custom: async () => assert.fail("no overlay without a UI") } };
    await present("plain", ctx);
    await presentDoc(doc.slice(0, 3), "T", kit, ctx);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(printed, ["plain", "Title\n\nSection 1\ns1 line 1"]);
});

test("with a UI: the overlay options pass through", async () => {
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
  await presentDoc(doc, "T", { ...kit, overlayOptions: { width: "100%" } }, ctx);
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
        if (calls.length === 1) throw new Error("overlay wiring changed");
        const pager = factory({ terminal: { rows: 10 } }, theme, {}, () => {});
        assert.match(pager.render(40).at(-1), /^1–7\/\d+ /);
      },
    },
  };
  await presentDoc(doc, "T", kit, ctx);
  assert.equal(calls.length, 2);
});
