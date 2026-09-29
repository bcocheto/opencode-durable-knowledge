import assert from "node:assert/strict"
import test from "node:test"

import { REVIEW_METADATA_KEY } from "../src/context-bridge.ts"
import { IdleReview, type IdleReviewDependencies } from "../src/idle-review.ts"
import type { PythonInvocation } from "../src/python-runner.ts"

const options = {
  pythonExecutable: "/usr/bin/python3",
  stopReviewScript: "/hooks/knowledge_stop_review.py",
  timeoutMs: 20_000,
}

const succeeded = (id: string, sessionID = "ses_1") => ({
  id: `evt_${id}`,
  type: "session.execution.succeeded",
  data: { sessionID },
})

const originalMessages = [
  { id: "user_1", type: "user", text: "sim, aprovo" },
  {
    id: "assistant_1",
    type: "assistant",
    content: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "Implemented." },
      { type: "text", text: "<!-- obsidian-review: durable -->" },
    ],
  },
]

const messages = [
  ...originalMessages,
  { id: "msg_boundary_1", type: "idle", outcome: "succeeded" },
]

const reviewMessages = [
  ...messages,
  {
    id: "review_1",
    type: "user",
    text: "Capture it.",
    metadata: { [REVIEW_METADATA_KEY]: true, originalTurnID: "user_1" },
  },
  {
    id: "assistant_review",
    type: "assistant",
    content: [{ type: "text", text: "Reviewed." }],
  },
  { id: "msg_boundary_2", type: "idle", outcome: "succeeded" },
]

function dependencies(overrides: Partial<IdleReviewDependencies> = {}) {
  const prompts: Array<Record<string, unknown>> = []
  const value: IdleReviewDependencies & {
    prompts: Array<Record<string, unknown>>
  } = {
    getSession: async () => ({
      outcome: "succeeded",
      location: { directory: "/workspace/acme" },
    }),
    getContext: async () => messages,
    prompt: async (input) => {
      prompts.push(input)
    },
    ...overrides,
    prompts,
  }
  return value
}

test("ignores non-successful execution events", async () => {
  let calls = 0
  const failed = dependencies()
  const review = new IdleReview(options, failed, async () => {
    calls += 1
    return {}
  })

  await review.handle({ id: "busy", type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })
  await review.handle({ id: "evt_failed", type: "session.execution.failed", data: { sessionID: "ses_1" } })

  assert.equal(calls, 0)
  assert.deepEqual(failed.prompts, [])
})

test("does nothing when policy review returns no decision", async () => {
  const deps = dependencies()
  const review = new IdleReview(options, deps, async () => ({}))

  await review.handle(succeeded("boundary_1"))

  assert.deepEqual(deps.prompts, [])
})

test("maps each durable execution event to its exact idle boundary", async () => {
  const calls: PythonInvocation[] = []
  const deps = dependencies({
    getContext: async () => [
      ...originalMessages,
      { id: "msg_boundary_1", type: "idle", outcome: "succeeded" },
      { id: "user_2", type: "user", text: "second turn" },
      {
        id: "assistant_2",
        type: "assistant",
        content: [{ type: "text", text: "Second response." }],
      },
      { id: "msg_boundary_2", type: "idle", outcome: "succeeded" },
    ],
  })
  const review = new IdleReview(options, deps, async (call) => {
    calls.push(call)
    return {}
  })

  await review.handle(succeeded("boundary_1"))
  await review.handle(succeeded("boundary_2"))

  assert.deepEqual(
    calls.map((call) => {
      const payload = call.payload as Record<string, unknown>
      return [payload.turn_id, payload.last_assistant_message]
    }),
    [
      ["user_1", "Implemented.\n<!-- obsidian-review: durable -->"],
      ["user_2", "Second response."],
    ],
  )
})

test("queues one marked continuation for a blocked original turn", async () => {
  const calls: PythonInvocation[] = []
  const deps = dependencies()
  const review = new IdleReview(options, deps, async (call) => {
    calls.push(call)
    return { decision: "block", reason: "Capture the approved decision." }
  })

  await review.handle(succeeded("boundary_1"))
  await review.handle(succeeded("boundary_1"))

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.payload, {
    session_id: "ses_1",
    turn_id: "user_1",
    cwd: "/workspace/acme",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Implemented.\n<!-- obsidian-review: durable -->",
  })
  assert.deepEqual(deps.prompts, [
    {
      sessionID: "ses_1",
      text: "Capture the approved decision.",
      delivery: "queue",
      metadata: {
        [REVIEW_METADATA_KEY]: true,
        originalTurnID: "user_1",
      },
    },
  ])
})

test("allows a receipt to resolve the second idle without active-stop recording", async () => {
  const calls: PythonInvocation[] = []
  let contextCalls = 0
  const deps = dependencies({
    getContext: async () => (contextCalls++ === 0 ? messages : reviewMessages),
  })
  const outputs = [
    { decision: "block", reason: "Capture it." },
    {},
  ]
  const review = new IdleReview(options, deps, async (call) => {
    calls.push(call)
    return outputs.shift() ?? {}
  })

  await review.handle(succeeded("boundary_1"))
  await review.handle(succeeded("boundary_2"))

  assert.equal(calls.length, 2)
  assert.equal((calls[1]!.payload as Record<string, unknown>).stop_hook_active, false)
  assert.equal(deps.prompts.length, 1)
})

test("records an unresolved second pass without queuing another continuation", async () => {
  const calls: PythonInvocation[] = []
  let contextCalls = 0
  const deps = dependencies({
    getContext: async () => (contextCalls++ === 0 ? messages : reviewMessages),
  })
  const review = new IdleReview(options, deps, async (call) => {
    calls.push(call)
    return (call.payload as Record<string, unknown>).stop_hook_active === true
      ? {}
      : { decision: "block", reason: "Still pending." }
  })

  await review.handle(succeeded("boundary_1"))
  await review.handle(succeeded("boundary_2"))
  await review.handle(succeeded("boundary_2"))

  assert.deepEqual(
    calls.map((call) => (call.payload as Record<string, unknown>).stop_hook_active),
    [false, false, true],
  )
  assert.equal(deps.prompts.length, 1)
})

test("bounds remembered event identifiers", async () => {
  let calls = 0
  const review = new IdleReview(options, dependencies({
    getContext: async (sessionID) => [
      { id: `user-${sessionID}`, type: "user", text: "ordinary" },
      { id: `assistant-${sessionID}`, type: "assistant", content: [] },
      { id: `msg_${sessionID}`, type: "idle", outcome: "succeeded" },
    ],
  }), async () => {
    calls += 1
    return {}
  })
  for (let index = 0; index < 1_025; index += 1) {
    await review.handle(succeeded(`ses-${index}`, `ses-${index}`))
  }

  await review.handle(succeeded("ses-0", "ses-0"))

  assert.equal(calls, 1_026)
})

test("correlates review continuations back to the original user turn", async () => {
  const calls: PythonInvocation[] = []
  const deps = dependencies({
    getContext: async () => reviewMessages,
  })
  const review = new IdleReview(options, deps, async (call) => {
    calls.push(call)
    return {}
  })

  await review.handle(succeeded("boundary_2"))

  assert.equal((calls[0]!.payload as Record<string, unknown>).turn_id, "user_1")
})

test("dispose aborts and awaits the single event subscription", async () => {
  let observed: AbortSignal | undefined
  const deps = dependencies({
    subscribe: (signal) => {
      observed = signal
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
        },
      }
    },
  })
  const review = new IdleReview(options, deps, async () => ({}))

  await review.dispose()

  assert.equal(observed?.aborted, true)
})

test("does not prompt after disposal races with an in-flight review", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const deps = dependencies({
    getContext: async () => {
      await gate
      return messages
    },
  })
  const review = new IdleReview(options, deps, async () => ({
    decision: "block",
    reason: "Must not be queued after disposal.",
  }))
  const pending = review.handle(succeeded("boundary_1"))

  const disposing = review.dispose()
  release()
  await Promise.all([pending, disposing])

  assert.deepEqual(deps.prompts, [])
})

test("never evicts pending turns to enqueue a second continuation", async () => {
  const deps = dependencies({
    getContext: async (sessionID) => [
      { id: `user-${sessionID}`, type: "user", text: "sim, aprovo" },
      { id: `assistant-${sessionID}`, type: "assistant", content: [] },
      { id: `msg_${sessionID}`, type: "idle", outcome: "succeeded" },
    ],
  })
  const review = new IdleReview(options, deps, async () => ({
    decision: "block",
    reason: "Capture it.",
  }))
  for (let index = 0; index < 257; index += 1) {
    await review.handle(succeeded(`ses-${index}`, `ses-${index}`))
  }
  await review.handle(succeeded("ses-0", "ses-0"))

  assert.equal(deps.prompts.length, 256)
  assert.equal(
    deps.prompts.filter((prompt) => prompt.sessionID === "ses-0").length,
    1,
  )
})

test("sanitized runner failures never enqueue continuation loops", async () => {
  const deps = dependencies()
  const review = new IdleReview(options, deps, async () => {
    throw new Error("RAW_POLICY_FAILURE")
  })

  await review.handle(succeeded("boundary_1"))
  await review.handle(succeeded("boundary_1"))

  assert.deepEqual(deps.prompts, [])
})

test("releases continuation capacity when prompt enqueue fails", async () => {
  let attempts = 0
  const deps = dependencies({
    getContext: async (sessionID) => [
      { id: `user-${sessionID}`, type: "user", text: "sim, aprovo" },
      { id: `assistant-${sessionID}`, type: "assistant", content: [] },
      { id: `msg_${sessionID}`, type: "idle", outcome: "succeeded" },
    ],
    prompt: async () => {
      attempts += 1
      throw new Error("queue unavailable")
    },
  })
  const review = new IdleReview(options, deps, async () => ({
    decision: "block",
    reason: "Capture it.",
  }))
  for (let index = 0; index < 300; index += 1) {
    await review.handle(succeeded(`ses-fail-${index}`, `ses-fail-${index}`))
  }

  assert.equal(attempts, 300)
})

test("never requeues an original turn once a marked review prompt exists", async () => {
  const deps = dependencies({ getContext: async () => reviewMessages })
  const review = new IdleReview(options, deps, async () => ({
    decision: "block",
    reason: "Still pending.",
  }))

  await review.handle(succeeded("boundary_1"))

  assert.deepEqual(deps.prompts, [])
})
