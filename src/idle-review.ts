import { REVIEW_METADATA_KEY } from "./context-bridge.js"
import type { PythonInvocation } from "./python-runner.js"
import { runPythonJson } from "./python-runner.js"
import {
  resolveUserTurn,
  type ProjectedMessage,
} from "./turn-correlation.js"

export interface IdleReviewOptions {
  readonly pythonExecutable: string
  readonly stopReviewScript: string
  readonly timeoutMs: number
}

export interface ReviewEvent {
  readonly id: string
  readonly type: string
  readonly data?: {
    readonly sessionID?: string
    readonly status?: { readonly type?: string }
  }
}

export interface ReviewMessage extends ProjectedMessage {
  readonly content?: readonly unknown[]
  readonly outcome?: unknown
}

export interface IdleReviewDependencies {
  readonly getSession: (sessionID: string) => Promise<{
    readonly outcome?: string
    readonly location: { readonly directory: string }
  }>
  readonly getContext: (sessionID: string) => Promise<readonly ReviewMessage[]>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly delivery: "queue"
    readonly metadata: Record<string, unknown>
  }) => Promise<unknown>
  readonly subscribe?: (signal: AbortSignal) => AsyncIterable<ReviewEvent>
}

type Runner = (invocation: PythonInvocation) => Promise<Record<string, unknown>>

class BoundedSet {
  readonly #limit: number
  readonly #values = new Set<string>()

  constructor(limit: number) {
    this.#limit = limit
  }

  has(value: string): boolean {
    return this.#values.has(value)
  }

  add(value: string): void {
    this.#values.delete(value)
    this.#values.add(value)
    if (this.#values.size > this.#limit) {
      const oldest = this.#values.values().next().value
      if (typeof oldest === "string") this.#values.delete(oldest)
    }
  }

  delete(value: string): void {
    this.#values.delete(value)
  }
}

class CapacitySet {
  readonly #limit: number
  readonly #values = new Set<string>()

  constructor(limit: number) {
    this.#limit = limit
  }

  has(value: string): boolean {
    return this.#values.has(value)
  }

  add(value: string): boolean {
    if (this.#values.has(value)) return true
    if (this.#values.size >= this.#limit) return false
    this.#values.add(value)
    return true
  }

  delete(value: string): void {
    this.#values.delete(value)
  }
}

function assistantText(message: ReviewMessage): string {
  if (!Array.isArray(message.content)) return ""
  return message.content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return []
      const candidate = part as Record<string, unknown>
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : []
    })
    .join("\n")
}

function blockReason(output: Record<string, unknown>): string | undefined {
  if (
    output.decision === "block" &&
    typeof output.reason === "string" &&
    output.reason.length > 0 &&
    output.reason.length <= 1_200
  ) {
    return output.reason
  }
  return undefined
}

function boundaryID(eventID: string): string | undefined {
  return eventID.startsWith("evt_") ? eventID.replace(/^evt_/, "msg_") : undefined
}

function latestAssistantIndex(
  messages: readonly ReviewMessage[],
  boundaryIndex: number,
): number {
  for (let index = boundaryIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === "assistant") return index
  }
  return -1
}

function isReviewContinuation(
  messages: readonly ReviewMessage[],
  assistantIndex: number,
  originalTurnID: string,
): boolean {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== "user") continue
    return (
      message.metadata?.[REVIEW_METADATA_KEY] === true &&
      message.metadata.originalTurnID === originalTurnID
    )
  }
  return false
}

function hasReviewPrompt(
  messages: readonly ReviewMessage[],
  originalTurnID: string,
): boolean {
  return messages.some(
    (message) =>
      message.type === "user" &&
      message.metadata?.[REVIEW_METADATA_KEY] === true &&
      message.metadata.originalTurnID === originalTurnID,
  )
}

export class IdleReview {
  readonly #options: IdleReviewOptions
  readonly #dependencies: IdleReviewDependencies
  readonly #runner: Runner
  readonly #controller = new AbortController()
  readonly #handledEvents = new BoundedSet(1_024)
  readonly #processingSessions = new Set<string>()
  readonly #continuedTurns = new CapacitySet(256)
  readonly #consumer: Promise<void>

  constructor(
    options: IdleReviewOptions,
    dependencies: IdleReviewDependencies,
    runner: Runner = runPythonJson,
  ) {
    this.#options = options
    this.#dependencies = dependencies
    this.#runner = runner
    this.#consumer = dependencies.subscribe
      ? this.#consume(dependencies.subscribe)
      : Promise.resolve()
  }

  async dispose(): Promise<void> {
    this.#controller.abort()
    await this.#consumer
  }

  async handle(event: ReviewEvent): Promise<void> {
    const sessionID = event.data?.sessionID
    if (
      event.type !== "session.execution.succeeded" ||
      typeof sessionID !== "string" ||
      this.#handledEvents.has(event.id) ||
      this.#processingSessions.has(sessionID)
    ) {
      return
    }
    this.#handledEvents.add(event.id)
    this.#processingSessions.add(sessionID)
    try {
      const session = await this.#dependencies.getSession(sessionID)
      if (this.#controller.signal.aborted) return

      const messages = await this.#dependencies.getContext(sessionID)
      if (this.#controller.signal.aborted) return
      const expectedBoundaryID = boundaryID(event.id)
      if (!expectedBoundaryID) return
      const boundaryIndex = messages.findIndex(
        (message) =>
          message.id === expectedBoundaryID &&
          message.type === "idle" &&
          message.outcome === "succeeded",
      )
      if (boundaryIndex < 0) return

      const assistantIndex = latestAssistantIndex(messages, boundaryIndex)
      if (assistantIndex < 0) return
      const assistant = messages[assistantIndex]
      if (!assistant) return
      const turn = resolveUserTurn(sessionID, messages, assistant.id)
      const key = `${sessionID}:${turn.turnID}`
      const continuation = isReviewContinuation(messages, assistantIndex, turn.turnID)
      const output = await this.#review(
        sessionID,
        turn.turnID,
        session.location.directory,
        assistantText(assistant),
        false,
      )
      if (this.#controller.signal.aborted) return
      const reason = blockReason(output)
      if (!reason) {
        this.#continuedTurns.delete(key)
        return
      }

      if (continuation) {
        await this.#review(
          sessionID,
          turn.turnID,
          session.location.directory,
          assistantText(assistant),
          true,
        )
        if (this.#controller.signal.aborted) return
        this.#continuedTurns.delete(key)
        return
      }

      if (hasReviewPrompt(messages, turn.turnID)) return
      if (!this.#continuedTurns.has(key)) {
        if (!this.#continuedTurns.add(key)) return
        if (this.#controller.signal.aborted) {
          this.#continuedTurns.delete(key)
          return
        }
        try {
          await this.#dependencies.prompt({
            sessionID,
            text: reason,
            delivery: "queue",
            metadata: {
              [REVIEW_METADATA_KEY]: true,
              originalTurnID: turn.turnID,
            },
          })
        } catch (error) {
          this.#continuedTurns.delete(key)
          throw error
        }
        return
      }
    } catch {
      // A failed review cannot safely block work or enqueue a blind continuation.
    } finally {
      this.#processingSessions.delete(sessionID)
    }
  }

  async #review(
    sessionID: string,
    turnID: string,
    directory: string,
    lastAssistantMessage: string,
    stopHookActive: boolean,
  ): Promise<Record<string, unknown>> {
    return await this.#runner({
      pythonExecutable: this.#options.pythonExecutable,
      script: this.#options.stopReviewScript,
      payload: {
        session_id: sessionID,
        turn_id: turnID,
        cwd: directory,
        hook_event_name: "Stop",
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantMessage,
      },
      timeoutMs: this.#options.timeoutMs,
      signal: this.#controller.signal,
    })
  }

  async #consume(subscribe: (signal: AbortSignal) => AsyncIterable<ReviewEvent>) {
    try {
      for await (const event of subscribe(this.#controller.signal)) {
        if (this.#controller.signal.aborted) break
        await this.handle(event)
      }
    } catch {
      // Subscription failures stay local and sanitized; a reload creates a new subscriber.
    }
  }
}
