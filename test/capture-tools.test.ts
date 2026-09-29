import assert from "node:assert/strict"
import test from "node:test"

import {
  APPROVAL_SOURCE,
  createCaptureTool,
  createTransientTool,
} from "../src/capture-tools.ts"
import type { PythonInvocation } from "../src/python-runner.ts"

const options = {
  pythonExecutable: "/usr/bin/python3",
  captureScript: "/hooks/knowledge_capture.py",
  timeoutMs: 20_000,
}

const messages = [
  { id: "user_1", type: "user", text: "sim, aprovo" },
  { id: "assistant_1", type: "assistant", content: [] },
]

const context = {
  sessionID: "ses_1",
  messageID: "assistant_1",
  signal: new AbortController().signal,
}

const input = {
  kind: "architecture",
  project: "Acme",
  title: "Use durable knowledge plugin",
  status: "accepted",
  rule: "OpenCode uses the durable knowledge plugin.",
  scope: "All OpenCode projects.",
  exceptions: [],
  consequences: ["Knowledge captures produce receipts."],
}

const receiptID = "a".repeat(64)

test("maps capture business fields to the exact correlated Python payload", async () => {
  const calls: PythonInvocation[] = []
  const tool = createCaptureTool(options, async () => messages, async (call) => {
    calls.push(call)
    return {
      status: "success",
      classification: "durable",
      receipt_id: receiptID,
      paths: ["Knowledge/Decisions/Decision.md"],
    }
  })

  const result = await tool.execute(input, context)

  assert.equal(tool.name, "capture")
  assert.deepEqual(tool.options, { namespace: "durable_knowledge", codemode: true })
  assert.deepEqual(calls[0], {
    pythonExecutable: "/usr/bin/python3",
    script: "/hooks/knowledge_capture.py",
    payload: {
      session_id: "ses_1",
      turn_id: "user_1",
      prompt_sha256:
        "a319ba368ddcef669b6df3ab1e35eba7096be97297ddf44526ebaa63e8bf25b0",
      kind: "architecture",
      project: "Acme",
      title: "Use durable knowledge plugin",
      status: "accepted",
      rule: "OpenCode uses the durable knowledge plugin.",
      scope: "All OpenCode projects.",
      exceptions: [],
      consequences: ["Knowledge captures produce receipts."],
      approval_source: APPROVAL_SOURCE,
      target_path: null,
      supersedes_path: null,
      successor_path: null,
    },
    timeoutMs: 20_000,
    acceptedExitCodes: [0, 2],
    signal: context.signal,
  })
  assert.equal(
    result.content,
    JSON.stringify({
      status: "success",
      classification: "durable",
      receipt_id: receiptID,
      paths: ["Knowledge/Decisions/Decision.md"],
    }),
  )
  assert.equal("output" in result, false)
})

test("maps optional relationship paths and rejects caller correlation fields", async () => {
  let calls = 0
  const tool = createCaptureTool(options, async () => messages, async () => {
    calls += 1
    return {
      status: "success",
      classification: "durable",
      receipt_id: receiptID,
      paths: ["Knowledge/Decisions/Decision.md"],
    }
  })

  await tool.execute(
    {
      ...input,
      targetPath: "Knowledge/Decisions/Existing.md",
      supersedesPath: "Knowledge/Decisions/Old.md",
      successorPath: "Knowledge/Decisions/New.md",
    },
    context,
  )
  assert.equal(calls, 1)

  await assert.rejects(
    tool.execute({ ...input, session_id: "forged" }, context),
    /invalid capture input/,
  )
  assert.equal(calls, 1)
  const properties = (tool.input as { properties: Record<string, unknown> }).properties
  assert.equal("session_id" in properties, false)
  assert.equal("prompt_sha256" in properties, false)
})

test("returns sanitized blocked policy results as machine-readable output", async () => {
  const blocked = {
    status: "blocked",
    classification: "blocked",
    reason: "approval evidence is missing or does not match",
    rollback: "not_started",
  }
  const tool = createCaptureTool(options, async () => messages, async () => blocked)

  const result = await tool.execute(input, context)

  assert.equal(result.content, JSON.stringify(blocked))
  assert.equal("output" in result, false)
})

test("classifies a correlated turn as transient using the dedicated argument", async () => {
  const calls: PythonInvocation[] = []
  const tool = createTransientTool(options, async () => messages, async (call) => {
    calls.push(call)
    return { status: "success", classification: "none", paths: [] }
  })

  const result = await tool.execute(
    { justification: "This applies only to the current run." },
    context,
  )

  assert.equal(tool.name, "classify_transient")
  assert.deepEqual(calls[0]?.args, ["--classify-transient"])
  assert.deepEqual(calls[0]?.payload, {
    session_id: "ses_1",
    turn_id: "user_1",
    prompt_sha256:
      "a319ba368ddcef669b6df3ab1e35eba7096be97297ddf44526ebaa63e8bf25b0",
    justification: "This applies only to the current run.",
  })
  assert.equal(
    result.content,
    JSON.stringify({ status: "success", classification: "none", paths: [] }),
  )
  assert.equal("output" in result, false)
})

test("rejects malformed or privacy-expanding policy output with a fixed error", async () => {
  const malformed = [
    { status: "success", classification: "durable", receipt_id: "short", paths: [] },
    {
      status: "success",
      classification: "durable",
      receipt_id: receiptID,
      paths: ["../outside.md"],
    },
    {
      status: "success",
      classification: "durable",
      receipt_id: receiptID,
      paths: ["Knowledge/Decision.md"],
      raw_prompt: "MUST_NOT_LEAK",
    },
  ]

  for (const output of malformed) {
    const tool = createCaptureTool(options, async () => messages, async () => output)
    await assert.rejects(
      tool.execute(input, context),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "invalid policy output" &&
        !String(error).includes("MUST_NOT_LEAK"),
    )
  }
})

test("rejects unexpected transient and blocked output fields", async () => {
  const transient = createTransientTool(options, async () => messages, async () => ({
    status: "success",
    classification: "none",
    paths: [],
    diagnostics: "MUST_NOT_LEAK",
  }))
  const blocked = createCaptureTool(options, async () => messages, async () => ({
    status: "blocked",
    classification: "blocked",
    reason: "blocked",
    rollback: "unknown",
  }))

  await assert.rejects(
    transient.execute({ justification: "temporary" }, context),
    /invalid policy output/,
  )
  await assert.rejects(blocked.execute(input, context), /invalid policy output/)
})
