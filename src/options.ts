import path from "node:path"

export interface PluginOptions {
  readonly pythonExecutable: string
  readonly contextScript: string
  readonly captureScript: string
  readonly stopReviewScript: string
  readonly timeoutMs: number
}

const REQUIRED_PATHS = [
  "pythonExecutable",
  "contextScript",
  "captureScript",
  "stopReviewScript",
] as const

const ALLOWED_KEYS = new Set<string>([...REQUIRED_PATHS, "timeoutMs"])
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 60_000

const invalid = (): never => {
  throw new TypeError("invalid plugin options")
}

export function parseOptions(value: unknown): PluginOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid()

  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) invalid()

  for (const key of REQUIRED_PATHS) {
    const candidate = input[key]
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) invalid()
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return invalid()
  }

  return {
    pythonExecutable: input.pythonExecutable as string,
    contextScript: input.contextScript as string,
    captureScript: input.captureScript as string,
    stopReviewScript: input.stopReviewScript as string,
    timeoutMs,
  }
}
