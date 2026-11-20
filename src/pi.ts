/**
 * pi-content-audit for Pi (`pi` manifest in package.json): the host wiring.
 * The collector is in pi-collect.ts, the report and viewer in core.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { register } from "./core.ts";
import { collect, items, notes } from "./pi-collect.ts";

export default function (pi: ExtensionAPI) {
  register(pi, {
    // Pi sizes an overlay from these; without them it is narrower than the terminal.
    ui: { visibleWidth, overlayOptions: { width: "100%", maxHeight: "100%" } },
    collect,
    items,
    ...notes,
  });
}
