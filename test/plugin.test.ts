import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../src/index.ts"

const options = {
  pythonExecutable: "/usr/bin/python3",
  contextScript: "/hooks/knowledge_context.py",
  captureScript: "/hooks/knowledge_capture.py",
  stopReviewScript: "/hooks/knowledge_stop_review.py",
  timeoutMs: 20_000,
}

function fakeContext(optionOverrides: Record<string, unknown> = {}) {
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const tools: any[] = []
  const namespaces: any[] = []
  const disposed: string[] = []
  const sessionGets: any[] = []
  let subscriptions = 0
  let subscriptionSignal: AbortSignal | undefined

  const registration = (name: string) => ({
    async dispose() {
      disposed.push(name)
    },
  })

  const context = {
    options: { ...options, ...optionOverrides },
    session: {
      async hook(name: string, callback: (event: any) => Promise<void> | void) {
        hooks.set(name, callback)
        return registration(`hook:${name}`)
      },
      async get(input: any) {
        sessionGets.push(input)
        return {
          id: input.sessionID,
          outcome: "succeeded",
          location: { directory: "/workspace/acme" },
        }
      },
      async context() {
        return []
      },
      async prompt() {},
    },
    tool: {
      async transform(callback: (editor: any) => void) {
        callback({
          namespace(value: any) {
            namespaces.push(value)
          },
          add(value: any) {
            tools.push(value)
          },
        })
        return registration("tools")
      },
    },
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        subscriptions += 1
        subscriptionSignal = signal
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (signal.aborted) return { done: true as const, value: undefined }
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true }),
                )
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      },
    },
  }

  return {
    context,
    hooks,
    tools,
    namespaces,
    disposed,
    sessionGets,
    get subscriptions() {
      return subscriptions
    },
    get subscriptionSignal() {
      return subscriptionSignal
    },
  }
}

test("assembles V2 hooks, tools, event subscription, and complete cleanup", async () => {
  const fake = fakeContext()

  const cleanup = await plugin.setup(fake.context as never)

  assert.equal(plugin.id, "bcocheto.durable-knowledge")
  assert.deepEqual([...fake.hooks.keys()], ["prompt", "context"])
  assert.deepEqual(fake.namespaces, [
    {
      name: "durable_knowledge",
      description: "Verified access to durable Obsidian knowledge.",
    },
  ])
  assert.deepEqual(
    fake.tools.map((tool) => [tool.name, tool.options.namespace]),
    [
      ["capture", "durable_knowledge"],
      ["classify_transient", "durable_knowledge"],
    ],
  )
  assert.equal(fake.subscriptions, 1)

  const prompt = {
    sessionID: "ses_1",
    messageID: "user_1",
    prompt: { text: "ordinary prompt" },
    metadata: {},
    delivery: "steer",
  }
  await fake.hooks.get("prompt")!(prompt)
  assert.deepEqual(fake.sessionGets, [{ sessionID: "ses_1" }])
  assert.equal(prompt.prompt.text, "ordinary prompt")

  const system: any[] = []
  await fake.hooks.get("context")!({ sessionID: "ses_1", system })
  assert.equal(system.length, 1)

  assert.equal(typeof cleanup, "function")
  await cleanup!()
  assert.deepEqual(fake.disposed.sort(), ["hook:context", "hook:prompt", "tools"])
  assert.equal(fake.subscriptionSignal?.aborted, true)
})

test("rejects invalid options before registering resources", async () => {
  const fake = fakeContext({ contextScript: "relative.py" })

  await assert.rejects(plugin.setup(fake.context as never), /invalid plugin options/)

  assert.deepEqual([...fake.hooks], [])
  assert.deepEqual(fake.tools, [])
  assert.equal(fake.subscriptions, 0)
})
