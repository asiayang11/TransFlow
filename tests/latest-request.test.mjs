import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Compile the real source in memory; no extra test framework or build artifacts.
const source = readFileSync(new URL("../src/latest-request.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { LatestRequest } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("new request aborts and invalidates the earlier response", () => {
  const slot = new LatestRequest();
  const first = slot.start();
  const second = slot.start();
  assert.equal(first.aborted, true);
  assert.equal(slot.owns(first), false);
  assert.equal(slot.owns(second), true);
});

test("reset invalidates all pending results", () => {
  const slot = new LatestRequest();
  const first = slot.start();
  slot.cancel();
  assert.equal(slot.owns(first), false);
  assert.equal(first.aborted, true);
});

test("delayed older response cannot overwrite a newer result", async () => {
  const slot = new LatestRequest();
  let completeOld;
  let value = null;
  const first = slot.start();
  const old = new Promise((resolve) => { completeOld = resolve; }).then(() => {
    if (slot.owns(first)) value = "old";
  });
  const second = slot.start();
  if (slot.owns(second)) value = "new";
  completeOld();
  await old;
  assert.equal(value, "new");
});
