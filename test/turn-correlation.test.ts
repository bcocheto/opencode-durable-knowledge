import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { REVIEW_METADATA_KEY } from "../src/context-bridge.ts"
import { resolveUserTurn } from "../src/turn-correlation.ts"

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

test("selects the nearest ordinary user before the executing assistant", () => {
  const messages = [
    { id: "user_1", type: "user", text: "first" },
    { id: "assistant_1", type: "assistant", content: [] },
    { id: "user_2", type: "user", text: "approved second" },
    { id: "assistant_2", type: "assistant", content: [] },
  ]

  assert.deepEqual(resolveUserTurn("ses_1", messages, "assistant_2"), {
    sessionID: "ses_1",
    turnID: "user_2",
    promptSha256: hash("approved second"),
  })
})

test("skips plugin review prompts while resolving the original turn", () => {
  const messages = [
    { id: "user_1", type: "user", text: "sim, aprovo" },
    { id: "assistant_1", type: "assistant", content: [] },
    {
      id: "review_1",
      type: "user",
      text: "review pending",
      metadata: { [REVIEW_METADATA_KEY]: true, originalTurnID: "user_1" },
    },
    { id: "assistant_review", type: "assistant", content: [] },
  ]

  assert.equal(
    resolveUserTurn("ses_1", messages, "assistant_review").turnID,
    "user_1",
  )
})

test("uses a marked review prompt's original turn across an intervening queued turn", () => {
  const messages = [
    { id: "user_original", type: "user", text: "sim, aprovo" },
    { id: "assistant_original", type: "assistant", content: [] },
    { id: "user_queued", type: "user", text: "unrelated queued request" },
    { id: "assistant_queued", type: "assistant", content: [] },
    {
      id: "review_1",
      type: "user",
      text: "review pending",
      metadata: {
        [REVIEW_METADATA_KEY]: true,
        originalTurnID: "user_original",
      },
    },
    { id: "assistant_review", type: "assistant", content: [] },
  ]

  assert.equal(
    resolveUserTurn("ses_1", messages, "assistant_review").turnID,
    "user_original",
  )
})

test("rejects marked review prompts with invalid original turn metadata", () => {
  assert.throws(
    () =>
      resolveUserTurn(
        "ses_1",
        [
          { id: "user_1", type: "user", text: "approved" },
          {
            id: "review_1",
            type: "user",
            text: "review",
            metadata: { [REVIEW_METADATA_KEY]: true, originalTurnID: "missing" },
          },
          { id: "assistant_review", type: "assistant", content: [] },
        ],
        "assistant_review",
      ),
    /turn correlation failed/,
  )
})

test("never selects a queued user message after the executing assistant", () => {
  const messages = [
    { id: "user_1", type: "user", text: "current" },
    { id: "assistant_1", type: "assistant", content: [] },
    { id: "user_queued", type: "user", text: "later queued" },
  ]

  assert.equal(resolveUserTurn("ses_1", messages, "assistant_1").turnID, "user_1")
})

test("rejects missing assistants, missing users, and malformed user text", () => {
  assert.throws(() => resolveUserTurn("ses_1", [], "missing"), /turn correlation failed/)
  assert.throws(
    () =>
      resolveUserTurn(
        "ses_1",
        [{ id: "assistant_1", type: "assistant", content: [] }],
        "assistant_1",
      ),
    /turn correlation failed/,
  )
  assert.throws(
    () =>
      resolveUserTurn(
        "ses_1",
        [
          { id: "user_1", type: "user", text: 7 },
          { id: "assistant_1", type: "assistant", content: [] },
        ],
        "assistant_1",
      ),
    /turn correlation failed/,
  )
})
