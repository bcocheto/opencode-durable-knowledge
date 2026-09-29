import assert from "node:assert/strict"
import test from "node:test"

import { parseOptions } from "../src/options.ts"

const required = {
  pythonExecutable: "/usr/bin/python3",
  contextScript: "/home/user/hooks/knowledge_context.py",
  captureScript: "/home/user/hooks/knowledge_capture.py",
  stopReviewScript: "/home/user/hooks/knowledge_stop_review.py",
}

test("accepts required absolute paths and applies the default timeout", () => {
  assert.deepEqual(parseOptions(required), { ...required, timeoutMs: 20_000 })
})

test("accepts positive integer timeouts through sixty seconds", () => {
  assert.equal(parseOptions({ ...required, timeoutMs: 1 }).timeoutMs, 1)
  assert.equal(parseOptions({ ...required, timeoutMs: 60_000 }).timeoutMs, 60_000)
})

test("rejects missing and relative paths", () => {
  for (const key of Object.keys(required)) {
    const missing = { ...required }
    delete missing[key as keyof typeof missing]
    assert.throws(() => parseOptions(missing), /invalid plugin options/)
    assert.throws(
      () => parseOptions({ ...required, [key]: "relative/path" }),
      /invalid plugin options/,
    )
  }
})

test("rejects unknown option keys", () => {
  assert.throws(() => parseOptions({ ...required, token: "secret" }), /invalid plugin options/)
})

test("rejects invalid timeout values", () => {
  for (const timeoutMs of [0, -1, 1.5, 60_001, "20000", Number.NaN]) {
    assert.throws(() => parseOptions({ ...required, timeoutMs }), /invalid plugin options/)
  }
})
