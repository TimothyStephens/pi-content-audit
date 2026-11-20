/**
 * pi-content-audit for OMP (`omp` manifest in package.json): the host wiring.
 * The collector is in omp-collect.ts, the report and viewer in core.ts.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getMarkdownTheme, setThemeInstance } from "@oh-my-pi/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { register } from "./core.ts";
import { collect, items, notes } from "./omp-collect.ts";

export default function (pi: ExtensionAPI) {
  register(pi, {
    ui: {
      Markdown,
      getMarkdownTheme,
      truncateToWidth,
      visibleWidth,
      // The extension's @oh-my-pi/pi-coding-agent import is a separate module
      // instance from the host's, so its theme singleton is never initialized.
      // The host passes its live theme to the overlay factory; install it so
      // getMarkdownTheme() renders with the active theme.
      adoptTheme: (hostTheme) => setThemeInstance(hostTheme as Parameters<typeof setThemeInstance>[0]),
    },
    collect,
    items,
    ...notes,
  });
}
