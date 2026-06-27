// H9: safeTool runtime guard. A tool handler that returns an object with an UN-AWAITED Promise
// property (the classic "forgot to await" footgun) must NOT silently serialize that property to
// `{}` on a success envelope. safeTool awaits the top-level return value but JSON.stringify of a
// nested Promise yields `{}`, so the agent would receive `{ ok:true, x:{} }` — a silent data-loss
// bug. The guard inspects the resolved result's own-enumerable properties and rejects any thenable,
// turning it into the standard `{ ok:false, error }` envelope via the surrounding try/catch.
//
// safeTool is the (now-exported) wrapper from the server entry module; importing it does NOT start
// the stdio server (main() is gated behind an entry-point check), so we can drive it directly.
import assert from "node:assert/strict";
import test from "node:test";
import { safeTool } from "../../dist/index.js";

test("safeTool rejects a handler that returns an un-awaited Promise property (no silent {})", async () => {
  const result = await safeTool(() => ({ x: Promise.resolve(1) }));
  assert.equal(result.isError, true, "an un-awaited Promise property must produce an error envelope");
  const body = result.structuredContent;
  assert.equal(body.ok, false, "must NOT be { ok:true, x:{} }");
  assert.match(body.error, /unawaited|un-awaited|promise/i, "error should name the un-awaited Promise");
  // The footgun value must not leak onto a success envelope.
  assert.equal("x" in body, false, "the un-awaited property must not appear on the (error) envelope");
});

test("safeTool names the offending property in the error", async () => {
  const result = await safeTool(() => ({ ok: true, deferred: Promise.resolve("v") }));
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /deferred/, "error should name the offending property key");
});

test("safeTool still wraps a normal object result into a success envelope", async () => {
  const result = await safeTool(() => ({ value: 42 }));
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.value, 42);
});

test("safeTool allows a bare top-level Promise return (it is awaited)", async () => {
  // The bare `return runDoctor(...)` pattern: the top-level return is a Promise, which safeTool
  // awaits. The RESOLVED object has no Promise property, so the guard passes.
  const result = await safeTool(() => Promise.resolve({ value: 7 }));
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.value, 7);
});

test("safeTool does not scan array results for thenables", async () => {
  // Arrays are wrapped as { result: [...] }, never treated as a property bag, so an array
  // containing a Promise (an odd but legal shape) is not rejected by the shallow property guard.
  const result = await safeTool(() => [Promise.resolve(1)]);
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
});
