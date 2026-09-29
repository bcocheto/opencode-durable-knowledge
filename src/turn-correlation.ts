import { createHash } from "node:crypto"

import { REVIEW_METADATA_KEY } from "./context-bridge.js"

export interface ProjectedMessage {
  readonly id: string
  readonly type: string
  readonly text?: unknown
  readonly metadata?: Record<string, unknown>
}

export interface CorrelatedTurn {
  readonly sessionID: string
  readonly turnID: string
  readonly promptSha256: string
}

const failed = (): never => {
  throw new Error("turn correlation failed")
}

export function resolveUserTurn(
  sessionID: string,
  messages: readonly ProjectedMessage[],
  assistantMessageID: string,
): CorrelatedTurn {
  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessageID && message.type === "assistant",
  )
  if (assistantIndex < 0) failed()

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== "user") continue
    if (message.metadata?.[REVIEW_METADATA_KEY] === true) {
      const originalTurnID = message.metadata.originalTurnID
      if (typeof originalTurnID !== "string" || originalTurnID.length === 0) {
        return failed()
      }
      const original = messages
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.id === originalTurnID &&
            candidate.type === "user" &&
            candidate.metadata?.[REVIEW_METADATA_KEY] !== true,
        )
      if (!original || typeof original.text !== "string") return failed()
      return {
        sessionID,
        turnID: original.id,
        promptSha256: createHash("sha256")
          .update(original.text, "utf8")
          .digest("hex"),
      }
    }
    if (typeof message.text !== "string") return failed()
    return {
      sessionID,
      turnID: message.id,
      promptSha256: createHash("sha256").update(message.text, "utf8").digest("hex"),
    }
  }
  return failed()
}
