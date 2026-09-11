// One hooks-order slip blanked the entire app: SceneAnalysisModal returned
// null while closed and then called useTeachSurface and two effects when it
// opened, so the first click on a library video threw mid-render and React
// unmounted the root. Nothing catches that at build time — tsc and Vite both
// compile it happily — so this test is the guard.

import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

import { describeViolation, findHookOrderViolations } from "./hookOrder";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("no component in the client calls a hook it could have returned before", () => {
  const violations = findHookOrderViolations(path.join(repoRoot, "client/src"), repoRoot);
  assert.deepEqual(
    violations.map(describeViolation),
    [],
    "A hook after an early return throws React error #310 on the render that stops taking the early return.",
  );
});

test("the checker catches the shape that broke the library, and allows `return useHook(...)`", () => {
  const fixture = path.join(repoRoot, "scripts/checks/__fixtures__");
  const found = findHookOrderViolations(fixture, repoRoot);
  assert.deepEqual(
    found.map((v) => `${v.component}:${v.hooks.join(",")}`),
    ["BrokenModal:useEffect@6"],
    "Expected exactly the broken component, with the hook it would skip.",
  );
});
