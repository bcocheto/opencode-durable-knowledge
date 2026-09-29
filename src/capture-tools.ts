import type { PythonInvocation } from "./python-runner.js"
import { runPythonJson } from "./python-runner.js"
import {
  resolveUserTurn,
  type ProjectedMessage,
} from "./turn-correlation.js"

export const APPROVAL_SOURCE = "OpenCode explicit approval signal"

const TOOL_OPTIONS = { namespace: "durable_knowledge", codemode: true } as const
const ACCEPTED_POLICY_EXIT_CODES = [0, 2] as const
const RECEIPT_ID = /^[0-9a-f]{64}$/
const ROLLBACK_STATUSES = new Set([
  "not_started",
  "not_required",
  "complete",
  "incomplete",
])

export interface CaptureToolOptions {
  readonly pythonExecutable: string
  readonly captureScript: string
  readonly timeoutMs: number
}

export interface KnowledgeToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly signal: AbortSignal
}

export interface KnowledgeTool {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly options: typeof TOOL_OPTIONS
  readonly execute: (
    input: unknown,
    context: KnowledgeToolContext,
  ) => Promise<{ content: string }>
}

type SessionContextReader = (
  sessionID: string,
) => Promise<readonly ProjectedMessage[]>
type Runner = (invocation: PythonInvocation) => Promise<Record<string, unknown>>

interface CaptureInput {
  readonly kind: string
  readonly project: string
  readonly title: string
  readonly status: "proposed" | "accepted" | "superseded" | "rejected"
  readonly rule: string
  readonly scope: string
  readonly exceptions: readonly string[]
  readonly consequences: readonly string[]
  readonly targetPath?: string | null
  readonly supersedesPath?: string | null
  readonly successorPath?: string | null
}

const CAPTURE_REQUIRED = [
  "kind",
  "project",
  "title",
  "status",
  "rule",
  "scope",
  "exceptions",
  "consequences",
] as const
const CAPTURE_KEYS = new Set<string>([
  ...CAPTURE_REQUIRED,
  "targetPath",
  "supersedesPath",
  "successorPath",
])
const STATUSES = new Set(["proposed", "accepted", "superseded", "rejected"])

const captureSchema = {
  type: "object",
  additionalProperties: false,
  required: [...CAPTURE_REQUIRED],
  properties: {
    kind: { type: "string" },
    project: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: [...STATUSES] },
    rule: { type: "string" },
    scope: { type: "string" },
    exceptions: { type: "array", items: { type: "string" } },
    consequences: { type: "array", items: { type: "string" } },
    targetPath: { type: ["string", "null"] },
    supersedesPath: { type: ["string", "null"] },
    successorPath: { type: ["string", "null"] },
  },
} as const

const transientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["justification"],
  properties: { justification: { type: "string" } },
} as const

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

function parseCaptureInput(value: unknown): CaptureInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid capture input")
  }
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !CAPTURE_KEYS.has(key)) ||
    CAPTURE_REQUIRED.some((key) => !(key in input)) ||
    !CAPTURE_REQUIRED.slice(0, 3).every((key) => typeof input[key] === "string") ||
    typeof input.rule !== "string" ||
    typeof input.scope !== "string" ||
    typeof input.status !== "string" ||
    !STATUSES.has(input.status) ||
    !isStringArray(input.exceptions) ||
    !isStringArray(input.consequences)
  ) {
    throw new TypeError("invalid capture input")
  }
  for (const key of ["targetPath", "supersedesPath", "successorPath"] as const) {
    if (key in input && input[key] !== null && typeof input[key] !== "string") {
      throw new TypeError("invalid capture input")
    }
  }
  return input as unknown as CaptureInput
}

function parseTransientInput(value: unknown): { justification: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as Record<string, unknown>).justification !== "string"
  ) {
    throw new TypeError("invalid transient input")
  }
  return { justification: (value as Record<string, string>).justification! }
}

const result = (output: Record<string, unknown>) => ({
  content: JSON.stringify(output),
})

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value)

function safeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false
  }
  const segments = value.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function parseBlockedOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (
    !exactKeys(output, ["status", "classification", "reason", "rollback"]) ||
    output.status !== "blocked" ||
    output.classification !== "blocked" ||
    typeof output.reason !== "string" ||
    output.reason.length === 0 ||
    output.reason.length > 1_200 ||
    typeof output.rollback !== "string" ||
    !ROLLBACK_STATUSES.has(output.rollback)
  ) {
    throw new Error("invalid policy output")
  }
  return {
    status: output.status,
    classification: output.classification,
    reason: output.reason,
    rollback: output.rollback,
  }
}

function parseCaptureOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (output.status === "blocked") return parseBlockedOutput(output)
  if (
    !exactKeys(output, ["status", "classification", "receipt_id", "paths"]) ||
    output.status !== "success" ||
    output.classification !== "durable" ||
    typeof output.receipt_id !== "string" ||
    !RECEIPT_ID.test(output.receipt_id) ||
    !Array.isArray(output.paths) ||
    output.paths.length === 0 ||
    output.paths.length > 8 ||
    !output.paths.every(safeRelativePath)
  ) {
    throw new Error("invalid policy output")
  }
  return {
    status: output.status,
    classification: output.classification,
    receipt_id: output.receipt_id,
    paths: [...output.paths],
  }
}

function parseTransientOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (output.status === "blocked") return parseBlockedOutput(output)
  if (
    !exactKeys(output, ["status", "classification", "paths"]) ||
    output.status !== "success" ||
    output.classification !== "none" ||
    !Array.isArray(output.paths) ||
    output.paths.length !== 0
  ) {
    throw new Error("invalid policy output")
  }
  return { status: "success", classification: "none", paths: [] }
}

export function createCaptureTool(
  options: CaptureToolOptions,
  readSessionContext: SessionContextReader,
  runner: Runner = runPythonJson,
): KnowledgeTool {
  return {
    name: "capture",
    description: "Persist an approved durable decision through the verified knowledge policy.",
    input: captureSchema,
    options: TOOL_OPTIONS,
    async execute(rawInput, context) {
      const input = parseCaptureInput(rawInput)
      const turn = resolveUserTurn(
        context.sessionID,
        await readSessionContext(context.sessionID),
        context.messageID,
      )
      const output = parseCaptureOutput(await runner({
        pythonExecutable: options.pythonExecutable,
        script: options.captureScript,
        payload: {
          session_id: turn.sessionID,
          turn_id: turn.turnID,
          prompt_sha256: turn.promptSha256,
          kind: input.kind,
          project: input.project,
          title: input.title,
          status: input.status,
          rule: input.rule,
          scope: input.scope,
          exceptions: [...input.exceptions],
          consequences: [...input.consequences],
          approval_source: APPROVAL_SOURCE,
          target_path: input.targetPath ?? null,
          supersedes_path: input.supersedesPath ?? null,
          successor_path: input.successorPath ?? null,
        },
        timeoutMs: options.timeoutMs,
        acceptedExitCodes: ACCEPTED_POLICY_EXIT_CODES,
        signal: context.signal,
      }))
      return result(output)
    },
  }
}

export function createTransientTool(
  options: CaptureToolOptions,
  readSessionContext: SessionContextReader,
  runner: Runner = runPythonJson,
): KnowledgeTool {
  return {
    name: "classify_transient",
    description: "Classify ambiguous durable intent as transient without writing the vault.",
    input: transientSchema,
    options: TOOL_OPTIONS,
    async execute(rawInput, context) {
      const input = parseTransientInput(rawInput)
      const turn = resolveUserTurn(
        context.sessionID,
        await readSessionContext(context.sessionID),
        context.messageID,
      )
      const output = parseTransientOutput(await runner({
        pythonExecutable: options.pythonExecutable,
        script: options.captureScript,
        args: ["--classify-transient"],
        payload: {
          session_id: turn.sessionID,
          turn_id: turn.turnID,
          prompt_sha256: turn.promptSha256,
          justification: input.justification,
        },
        timeoutMs: options.timeoutMs,
        acceptedExitCodes: ACCEPTED_POLICY_EXIT_CODES,
        signal: context.signal,
      }))
      return result(output)
    },
  }
}
