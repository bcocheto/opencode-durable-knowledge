import { spawn } from "node:child_process"

const MAX_STDOUT_BYTES = 256 * 1024
const MAX_INPUT_BYTES = 256 * 1024

export type PythonInvocationErrorCode =
  | "aborted"
  | "invalid_input"
  | "invalid_output"
  | "nonzero_exit"
  | "output_limit"
  | "spawn_failed"
  | "timeout"

export class PythonInvocationError extends Error {
  readonly code: PythonInvocationErrorCode

  constructor(code: PythonInvocationErrorCode) {
    super(`python invocation failed: ${code}`)
    this.name = "PythonInvocationError"
    this.code = code
  }
}

export interface PythonInvocation {
  readonly pythonExecutable: string
  readonly script: string
  readonly args?: readonly string[]
  readonly payload: unknown
  readonly timeoutMs: number
  readonly acceptedExitCodes?: readonly number[]
  readonly signal?: AbortSignal
}

export async function runPythonJson(
  invocation: PythonInvocation,
): Promise<Record<string, unknown>> {
  if (invocation.signal?.aborted) throw new PythonInvocationError("aborted")

  let encoded: string
  try {
    encoded = JSON.stringify(invocation.payload)
  } catch {
    throw new PythonInvocationError("invalid_input")
  }
  if (typeof encoded !== "string") throw new PythonInvocationError("invalid_input")
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    throw new PythonInvocationError("invalid_input")
  }

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const detached = process.platform !== "win32"
    const child = spawn(
      invocation.pythonExecutable,
      [invocation.script, ...(invocation.args ?? [])],
      { detached, stdio: ["pipe", "pipe", "pipe"] },
    )
    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let forced: PythonInvocationErrorCode | undefined
    let settled = false
    let settlementTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      clearTimeout(timer)
      if (settlementTimer) clearTimeout(settlementTimer)
      invocation.signal?.removeEventListener("abort", abort)
    }
    const finish = (
      callback: () => void,
    ) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const stop = (code: PythonInvocationErrorCode) => {
      if (forced || settled) return
      forced = code
      try {
        if (detached && typeof child.pid === "number") {
          process.kill(-child.pid, "SIGKILL")
        } else {
          child.kill("SIGKILL")
        }
      } catch {
        child.kill("SIGKILL")
      }
      child.stdin.destroy()
      settlementTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(() => reject(new PythonInvocationError(code)))
      }, 250)
    }
    const abort = () => stop("aborted")
    const timer = setTimeout(() => stop("timeout"), invocation.timeoutMs)

    invocation.signal?.addEventListener("abort", abort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop("output_limit")
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", () => {
      // Drain without retaining or exposing policy-engine diagnostics.
    })
    child.on("error", () => {
      finish(() => reject(new PythonInvocationError(forced ?? "spawn_failed")))
    })
    child.on("close", (code) => {
      finish(() => {
        if (forced) {
          reject(new PythonInvocationError(forced))
          return
        }
        if (code === null || !(invocation.acceptedExitCodes ?? [0]).includes(code)) {
          reject(new PythonInvocationError("nonzero_exit"))
          return
        }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new TypeError("not an object")
          }
          resolve(value as Record<string, unknown>)
        } catch {
          reject(new PythonInvocationError("invalid_output"))
        }
      })
    })

    child.stdin.on("error", () => {
      // The close/error event owns the public outcome.
    })
    child.stdin.end(encoded)
  })
}
