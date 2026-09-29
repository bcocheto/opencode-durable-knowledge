import type { PythonInvocation } from "./python-runner.js"
import { runPythonJson } from "./python-runner.js"

const MAX_CONTEXT_CHARS = 7_200
const MAX_RETAINED_SESSIONS = 128

export const REVIEW_METADATA_KEY = "bcocheto.durableKnowledge.review"
export const MANUAL_REVIEW_WARNING =
  "Knowledge context unavailable; manual review required."

export interface ContextBridgeOptions {
  readonly pythonExecutable: string
  readonly contextScript: string
  readonly timeoutMs: number
}

export interface PreparePromptInput {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: string
  readonly directory: string
  readonly metadata?: Record<string, unknown>
  readonly signal?: AbortSignal
}

export interface SystemTextPart {
  readonly type: "text"
  readonly text: string
}

type Runner = (invocation: PythonInvocation) => Promise<Record<string, unknown>>

interface SessionContext {
  startup?: string
  prompt?: string
  failed: boolean
}

function additionalContext(output: Record<string, unknown>): string {
  const hookOutput = output.hookSpecificOutput
  if (typeof hookOutput !== "object" || hookOutput === null || Array.isArray(hookOutput)) {
    throw new TypeError("invalid context output")
  }
  const context = (hookOutput as Record<string, unknown>).additionalContext
  if (
    typeof context !== "string" ||
    context.length === 0 ||
    context.length > MAX_CONTEXT_CHARS
  ) {
    throw new TypeError("invalid context output")
  }
  return context
}

export class ContextBridge {
  readonly #options: ContextBridgeOptions
  readonly #runner: Runner
  readonly #sessions = new Map<string, SessionContext>()

  constructor(options: ContextBridgeOptions, runner: Runner = runPythonJson) {
    this.#options = options
    this.#runner = runner
  }

  isReviewPrompt(metadata: Record<string, unknown> | undefined): boolean {
    return metadata?.[REVIEW_METADATA_KEY] === true
  }

  async preparePrompt(input: PreparePromptInput): Promise<void> {
    if (this.isReviewPrompt(input.metadata)) return

    const current = this.#sessions.get(input.sessionID) ?? { failed: false }
    try {
      if (current.startup === undefined) {
        current.startup = await this.#invoke(input, "SessionStart")
      }
      current.prompt = await this.#invoke(input, "UserPromptSubmit")
      current.failed = false
    } catch {
      current.failed = true
      delete current.prompt
    }
    this.#sessions.delete(input.sessionID)
    this.#sessions.set(input.sessionID, current)
    if (this.#sessions.size > MAX_RETAINED_SESSIONS) {
      const oldest = this.#sessions.keys().next().value
      if (typeof oldest === "string") this.#sessions.delete(oldest)
    }
  }

  appendContext(sessionID: string, system: SystemTextPart[]): void {
    const context = this.#sessions.get(sessionID)
    if (!context) return
    if (context.failed) {
      system.push({ type: "text", text: MANUAL_REVIEW_WARNING })
      return
    }
    const combined = [context.startup, context.prompt].filter(Boolean).join("\n")
    if (combined) system.push({ type: "text", text: combined })
  }

  async #invoke(
    input: PreparePromptInput,
    hookEventName: "SessionStart" | "UserPromptSubmit",
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      session_id: input.sessionID,
      turn_id: input.messageID,
      cwd: input.directory,
      hook_event_name: hookEventName,
    }
    if (hookEventName === "UserPromptSubmit") payload.prompt = input.prompt

    const invocation: PythonInvocation = {
      pythonExecutable: this.#options.pythonExecutable,
      script: this.#options.contextScript,
      payload,
      timeoutMs: this.#options.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    }
    return additionalContext(await this.#runner(invocation))
  }
}
