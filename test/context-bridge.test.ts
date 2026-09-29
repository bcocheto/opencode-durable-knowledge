import assert from "node:assert/strict"
import test from "node:test"

import {
  ContextBridge,
  MANUAL_REVIEW_WARNING,
  REVIEW_METADATA_KEY,
} from "../src/context-bridge.ts"
import type { PythonInvocation } from "../src/python-runner.ts"

const options = {
  pythonExecutable: "/usr/bin/python3",
  contextScript: "/hooks/knowledge_context.py",
  timeoutMs: 20_000,
}

const prompt = {
  sessionID: "ses_test",
  messageID: "msg_user_1",
  prompt: "A raw prompt that must not be retained",
  directory: "/workspace/acme",
}

test("prepares SessionStart once and UserPromptSubmit for every ordinary prompt", async () => {
  const calls: PythonInvocation[] = []
  const runner = async (invocation: PythonInvocation) => {
    calls.push(invocation)
    const event = (invocation.payload as Record<string, unknown>).hook_event_name
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: `${event} pointer context`,
      },
    }
  }
  const bridge = new ContextBridge(options, runner)

  await bridge.preparePrompt(prompt)
  await bridge.preparePrompt({ ...prompt, messageID: "msg_user_2", prompt: "next" })

  assert.deepEqual(
    calls.map((call) => (call.payload as Record<string, unknown>).hook_event_name),
    ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"],
  )
  assert.deepEqual(calls[1]?.payload, {
    session_id: "ses_test",
    turn_id: "msg_user_1",
    cwd: "/workspace/acme",
    hook_event_name: "UserPromptSubmit",
    prompt: "A raw prompt that must not be retained",
  })

  const system: Array<{ type: string; text: string }> = []
  bridge.appendContext("ses_test", system)
  assert.equal(system.length, 1)
  assert.match(system[0]!.text, /SessionStart pointer context/)
  assert.match(system[0]!.text, /UserPromptSubmit pointer context/)
  assert.doesNotMatch(system[0]!.text, /raw prompt|next/i)
})

test("does not mutate canonical prompt input", async () => {
  const input = { ...prompt }
  const bridge = new ContextBridge(options, async () => ({
    hookSpecificOutput: { additionalContext: "pointer" },
  }))

  await bridge.preparePrompt(input)

  assert.deepEqual(input, prompt)
})

test("ignores plugin-generated review prompts", async () => {
  let calls = 0
  const bridge = new ContextBridge(options, async () => {
    calls += 1
    return { hookSpecificOutput: { additionalContext: "pointer" } }
  })
  const metadata = { [REVIEW_METADATA_KEY]: true }

  assert.equal(bridge.isReviewPrompt(metadata), true)
  await bridge.preparePrompt({ ...prompt, metadata })

  assert.equal(calls, 0)
})

test("replaces invalid, oversized, and failed policy output with one fixed warning", async () => {
  for (const runner of [
    async () => ({ hookSpecificOutput: { additionalContext: "x".repeat(7_201) } }),
    async () => ({ hookSpecificOutput: { additionalContext: 3 } }),
    async () => {
      throw new Error("RAW_SCRIPT_DETAIL")
    },
  ]) {
    const bridge = new ContextBridge(options, runner)
    await bridge.preparePrompt(prompt)
    const system: Array<{ type: string; text: string }> = []

    bridge.appendContext("ses_test", system)

    assert.deepEqual(system, [{ type: "text", text: MANUAL_REVIEW_WARNING }])
    assert.doesNotMatch(JSON.stringify(system), /RAW_SCRIPT_DETAIL|raw prompt/i)
  }
})

test("bounds retained session context and evicts the oldest session", async () => {
  const bridge = new ContextBridge(options, async () => ({
    hookSpecificOutput: { additionalContext: "pointer" },
  }))
  for (let index = 0; index < 129; index += 1) {
    await bridge.preparePrompt({
      ...prompt,
      sessionID: `ses_${index}`,
      messageID: `msg_${index}`,
    })
  }
  const oldest: Array<{ type: string; text: string }> = []
  const newest: Array<{ type: string; text: string }> = []

  bridge.appendContext("ses_0", oldest)
  bridge.appendContext("ses_128", newest)

  assert.deepEqual(oldest, [])
  assert.equal(newest.length, 1)
})
