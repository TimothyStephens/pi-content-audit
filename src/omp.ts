/**
 * pi-content-audit for OMP (`omp` manifest in package.json): the host wiring.
 * The collector is in omp-collect.ts, the report and viewer in core.ts.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { register } from "./core.ts";
import { collect, items, notes } from "./omp-collect.ts";

export default function (pi: ExtensionAPI) {
  register(pi, {
    ui: { visibleWidth },
    collect,
    items,
    ...notes,
  });
}
