// The manifest: what an install fetches. Both hosts resolve @oh-my-pi/*, @earendil-works/* and
// @mariozechner/* imports to their own bundled copies (Pi: jiti aliases; OMP: legacy-pi-compat.ts remaps
// them "instead of pulling a duplicate copy from plugin node_modules"), so declaring them as dependencies
// only made every install download OMP: agentbox's Pi install was killed for memory doing it (20 Nov).
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("an install fetches nothing: the host packages are optional peers, not dependencies", () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  for (const name of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui"]) {
    assert.ok(pkg.peerDependencies?.[name], `${name} is a peer`);
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} is optional, so npm never installs it`);
  }
});

test("both hosts find their entry point", () => {
  assert.deepEqual(pkg.omp.extensions, ["./src/omp.ts"]);
  assert.deepEqual(pkg.pi.extensions, ["./src/pi.ts"]);
});
