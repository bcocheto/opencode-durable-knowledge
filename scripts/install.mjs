#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const PLUGIN_BASENAME = "opencode-durable-knowledge"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function invalid() {
  throw new TypeError("invalid installer input")
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid()
  for (const key of [
    "configPath",
    "pluginPath",
    "pythonExecutable",
    "contextScript",
    "captureScript",
    "stopReviewScript",
  ]) {
    if (typeof input[key] !== "string" || !path.isAbsolute(input[key])) invalid()
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 60_000
  ) {
    invalid()
  }
}

function ownsEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  if (typeof entry.package !== "string") return false
  return path.basename(entry.package.replace(/\/+$/, "")) === PLUGIN_BASENAME
}

async function managedRollback(io, input, rollbackPath, current) {
  const rollbackInfo = await io.lstat(rollbackPath)
  if (!rollbackInfo.isFile()) throw new Error("rollback is not a regular file")
  const existing = JSON.parse((await io.readFile(rollbackPath)).toString("utf8"))
  const backupPath = existing?.backupPath
  const expectedPrefix = `${path.basename(input.configPath)}.backup-`
  if (
    existing?.schemaVersion !== 1 ||
    existing?.pluginID !== "bcocheto.durable-knowledge" ||
    existing?.pluginPackage !== input.pluginPath ||
    existing?.configPath !== input.configPath ||
    typeof backupPath !== "string" ||
    !path.isAbsolute(backupPath) ||
    path.dirname(backupPath) !== path.dirname(input.configPath) ||
    !path.basename(backupPath).startsWith(expectedPrefix) ||
    typeof existing.beforeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(existing.beforeSha256) ||
    existing.afterSha256 !== sha256(current)
  ) {
    throw new Error("rollback metadata is invalid")
  }
  const backupInfo = await io.lstat(backupPath)
  if (!backupInfo.isFile()) throw new Error("backup is not a regular file")
  const backup = await io.readFile(backupPath)
  if (sha256(backup) !== existing.beforeSha256) throw new Error("backup hash is invalid")
  await io.chmod(input.configPath, 0o600)
  await io.chmod(rollbackPath, 0o600)
  await io.chmod(backupPath, 0o600)
  return backupPath
}

async function writePrivate(io, target, content) {
  const handle = await io.open(target, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.chmod(0o600)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(io, directory) {
  const handle = await io.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function install(input, io = fs) {
  validate(input)
  const configDirectory = path.dirname(input.configPath)
  const nonce = `${Date.now()}-${randomUUID()}`
  const backupPath = `${input.configPath}.backup-${nonce}`
  const rollbackPath = `${input.configPath}.durable-knowledge-rollback.json`
  const configTemp = path.join(configDirectory, `.${path.basename(input.configPath)}.tmp-${nonce}`)
  const rollbackTemp = path.join(configDirectory, `.${path.basename(rollbackPath)}.tmp-${nonce}`)
  let rollbackPublished = false
  let configPublished = false
  let previousRollback = null

  let original
  let parsed
  try {
    original = await io.readFile(input.configPath)
    parsed = JSON.parse(original.toString("utf8"))
  } catch {
    throw new Error("installation failed")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid()
  if (parsed.plugins !== undefined && !Array.isArray(parsed.plugins)) invalid()

  const pluginEntry = {
    package: input.pluginPath,
    options: {
      pythonExecutable: input.pythonExecutable,
      contextScript: input.contextScript,
      captureScript: input.captureScript,
      stopReviewScript: input.stopReviewScript,
      timeoutMs: input.timeoutMs,
    },
  }
  const plugins = [...(parsed.plugins ?? [])]
  const ownedEntries = plugins.filter(ownsEntry)
  if (ownedEntries.length === 1 && stable(ownedEntries[0]) === stable(pluginEntry)) {
    try {
      const existingBackupPath = await managedRollback(
        io,
        input,
        rollbackPath,
        original,
      )
      return {
        status: "unchanged",
        pluginPackage: input.pluginPath,
        backupPath: existingBackupPath,
        rollbackPath,
      }
    } catch {
      throw new Error("installation failed: rollback unavailable")
    }
  }
  const insertionIndex = plugins.findIndex(ownsEntry)
  const retained = plugins.filter((entry) => !ownsEntry(entry))
  retained.splice(insertionIndex < 0 ? retained.length : insertionIndex, 0, pluginEntry)
  const updated = Buffer.from(`${JSON.stringify({ ...parsed, plugins: retained }, null, 2)}\n`)
  const rollback = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pluginID: "bcocheto.durable-knowledge",
        pluginPackage: input.pluginPath,
        configPath: input.configPath,
        backupPath,
        beforeSha256: sha256(original),
        afterSha256: sha256(updated),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )

  try {
    previousRollback = await io.readFile(rollbackPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("installation failed")
  }

  try {
    await writePrivate(io, backupPath, original)
    await writePrivate(io, configTemp, updated)
    await writePrivate(io, rollbackTemp, rollback)
    const current = await io.readFile(input.configPath)
    if (!Buffer.from(current).equals(original)) throw new Error("config changed")
    await io.rename(configTemp, input.configPath)
    configPublished = true
    await io.rename(rollbackTemp, rollbackPath)
    rollbackPublished = true
    await syncDirectory(io, configDirectory)
  } catch {
    let restorationComplete = !configPublished
    let rollbackRecoveryComplete = !rollbackPublished
    let previousRecoveryPath = null
    if (configPublished) {
      const restoreTemp = path.join(
        configDirectory,
        `.${path.basename(input.configPath)}.restore-${nonce}`,
      )
      try {
        await writePrivate(io, restoreTemp, original)
        await io.rename(restoreTemp, input.configPath)
        await syncDirectory(io, configDirectory)
        restorationComplete = true
      } catch {
        await io.rm(restoreTemp, { force: true }).catch(() => {})
      }
    }
    if (rollbackPublished && restorationComplete) {
      if (previousRollback) {
        const previousTemp = path.join(
          configDirectory,
          `.${path.basename(rollbackPath)}.previous-${nonce}`,
        )
        try {
          await writePrivate(io, previousTemp, previousRollback)
          await io.rename(previousTemp, rollbackPath)
          await syncDirectory(io, configDirectory)
          rollbackRecoveryComplete = true
        } catch {
          previousRecoveryPath = previousTemp
        }
      } else {
        // Keep the new private metadata and backup as evidence of the failed transaction.
        rollbackRecoveryComplete = true
      }
    }
    await io.rm(configTemp, { force: true }).catch(() => {})
    if (restorationComplete || rollbackPublished) {
      await io.rm(rollbackTemp, { force: true }).catch(() => {})
    }
    if (
      (configPublished && !restorationComplete) ||
      (rollbackPublished && !rollbackRecoveryComplete)
    ) {
      const evidencePath = rollbackPublished ? rollbackPath : rollbackTemp
      const previousEvidence = previousRecoveryPath
        ? `; previous rollback metadata: ${previousRecoveryPath}`
        : ""
      throw new Error(
        `installation failed; rollback metadata: ${evidencePath}; backup: ${backupPath}${previousEvidence}`,
      )
    }
    throw new Error("installation failed")
  }

  return {
    status: "installed",
    pluginPackage: input.pluginPath,
    backupPath,
    rollbackPath,
  }
}

export function installErrorMessage(error) {
  const message = error instanceof Error ? error.message : ""
  return message.startsWith("installation failed; rollback metadata:")
    ? message
    : "durable knowledge installation failed"
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith("--") || value === undefined) invalid()
    values[flag.slice(2)] = value
  }
  return {
    configPath: values.config,
    pluginPath: values.plugin,
    pythonExecutable: values.python,
    contextScript: values.context,
    captureScript: values.capture,
    stopReviewScript: values.review,
    timeoutMs: values.timeout === undefined ? 20_000 : Number(values.timeout),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await install(parseArguments(process.argv.slice(2)))
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(installErrorMessage(error))
    process.exitCode = 1
  }
}
