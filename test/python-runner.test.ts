import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  PythonInvocationError,
  runPythonJson,
  type PythonInvocationErrorCode,
} from "../src/python-runner.ts"

const script = fileURLToPath(new URL("./fixtures/json-script.py", import.meta.url))

const invocation = (mode: string, overrides: Record<string, unknown> = {}) => ({
  pythonExecutable: "/usr/bin/python3",
  script,
  args: [mode],
  payload: { value: "ok" },
  timeoutMs: 1_000,
  ...overrides,
})

async function expectCode(
  promise: Promise<unknown>,
  code: PythonInvocationErrorCode,
): Promise<PythonInvocationError> {
  try {
    await promise
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert.ok(error instanceof PythonInvocationError)
    assert.equal(error.code, code)
    return error
  }
}

test("round-trips JSON and passes positional arguments", async () => {
  const result = await runPythonJson({
    ...invocation("echo"),
    args: ["echo", "--classify-transient"],
  })

  assert.deepEqual(result, {
    payload: { value: "ok" },
    args: ["--classify-transient"],
  })
})

test("rejects valid JSON that is not an object", async () => {
  await expectCode(runPythonJson(invocation("list")), "invalid_output")
})

test("rejects malformed JSON output", async () => {
  await expectCode(runPythonJson(invocation("malformed")), "invalid_output")
})

test("sanitizes nonzero exits without exposing stdin or stderr", async () => {
  const error = await expectCode(
    runPythonJson(invocation("fail", { payload: { secret: "RAW_STDIN_MARKER" } })),
    "nonzero_exit",
  )

  assert.equal(error.message, "python invocation failed: nonzero_exit")
  assert.doesNotMatch(String(error), /RAW_(?:STDIN|STDERR)_MARKER/)
})

test("parses explicitly accepted nonzero policy exits", async () => {
  const result = await runPythonJson(
    invocation("fail", { acceptedExitCodes: [0, 7] }),
  )

  assert.deepEqual(result, {})
})

test("terminates scripts that exceed the timeout", async () => {
  await expectCode(runPythonJson(invocation("sleep", { timeoutMs: 25 })), "timeout")
})

test("terminates scripts when the abort signal fires", async () => {
  const controller = new AbortController()
  const pending = runPythonJson(invocation("sleep", { signal: controller.signal }))
  setTimeout(() => controller.abort(), 25)

  await expectCode(pending, "aborted")
})

test("rejects stdout larger than 256 KiB", async () => {
  await expectCode(runPythonJson(invocation("large")), "output_limit")
})

test("rejects JSON input larger than 256 KiB before spawning Python", async () => {
  await expectCode(
    runPythonJson(
      invocation("echo", { payload: { data: "x".repeat(300 * 1024) } }),
    ),
    "invalid_input",
  )
})

test("timeout remains bounded when a descendant inherits stdio", async () => {
  const started = Date.now()

  await expectCode(runPythonJson(invocation("fork", { timeoutMs: 25 })), "timeout")

  assert.ok(Date.now() - started < 1_000)
})
