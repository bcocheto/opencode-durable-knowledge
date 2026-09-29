import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { install, installErrorMessage } from "../scripts/install.mjs"

async function fixture() {
  const root = await fs.mkdtemp(path.join("/tmp/opencode", "durable-installer-"))
  const configPath = path.join(root, "opencode.json")
  const pluginPath = path.join(root, "opencode-durable-knowledge")
  await fs.mkdir(pluginPath)
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["legacy-plugin"],
    plugins: ["existing-plugin", { package: "/old/opencode-durable-knowledge", options: { old: true } }],
    references: { vault: { path: "/vault" } },
    mcp: { servers: { obsidian: { headers: { Authorization: "SECRET_HEADER" } } } },
    unknown: { preserve: true },
  }
  const original = `${JSON.stringify(config, null, 2)}\n`
  await fs.writeFile(configPath, original, { mode: 0o644 })
  return { root, configPath, pluginPath, config, original }
}

const scriptOptions = {
  pythonExecutable: "/usr/bin/python3",
  contextScript: "/home/user/hooks/knowledge_context.py",
  captureScript: "/home/user/hooks/knowledge_capture.py",
  stopReviewScript: "/home/user/hooks/knowledge_stop_review.py",
  timeoutMs: 20_000,
}

test("preserves unrelated config and installs exactly one private plugin entry", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))

  const first = await install({
    configPath: value.configPath,
    pluginPath: value.pluginPath,
    ...scriptOptions,
  })
  const rollbackBeforeReinstall = await fs.readFile(first.rollbackPath, "utf8")
  const second = await install({
    configPath: value.configPath,
    pluginPath: value.pluginPath,
    ...scriptOptions,
  })

  const installed = JSON.parse(await fs.readFile(value.configPath, "utf8"))
  assert.deepEqual(installed.plugin, value.config.plugin)
  assert.deepEqual(installed.references, value.config.references)
  assert.deepEqual(installed.mcp, value.config.mcp)
  assert.deepEqual(installed.unknown, value.config.unknown)
  assert.deepEqual(installed.plugins, [
    "existing-plugin",
    { package: value.pluginPath, options: scriptOptions },
  ])
  assert.equal((await fs.stat(value.configPath)).mode & 0o777, 0o600)

  assert.equal(await fs.readFile(first.backupPath, "utf8"), value.original)
  assert.equal(second.status, "unchanged")
  assert.equal(second.backupPath, first.backupPath)
  assert.equal(await fs.readFile(first.rollbackPath, "utf8"), rollbackBeforeReinstall)
  assert.equal((await fs.stat(first.backupPath)).mode & 0o777, 0o600)
  const rollback = JSON.parse(await fs.readFile(first.rollbackPath, "utf8"))
  assert.equal(rollback.pluginPackage, value.pluginPath)
  assert.match(rollback.beforeSha256, /^[0-9a-f]{64}$/)
  assert.match(rollback.afterSha256, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(rollback), /SECRET_HEADER/)
  assert.equal((await fs.stat(first.rollbackPath)).mode & 0o777, 0o600)
  assert.equal(
    (await fs.readdir(value.root)).some((name) => name.includes(".tmp-")),
    false,
  )
})

test("aborts rather than overwriting a concurrent config update", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const concurrent = `${JSON.stringify({ ...value.config, concurrent: true }, null, 2)}\n`
  let configReads = 0
  const changingIO = {
    ...fs,
    async readFile(target: fs.PathLike, options?: { encoding?: null } | null) {
      if (String(target) === value.configPath) {
        configReads += 1
        if (configReads === 2) await fs.writeFile(value.configPath, concurrent)
      }
      return await fs.readFile(target, options as never)
    },
  }

  await assert.rejects(
    install(
      {
        configPath: value.configPath,
        pluginPath: value.pluginPath,
        ...scriptOptions,
      },
      changingIO,
    ),
    /installation failed/,
  )

  assert.equal(await fs.readFile(value.configPath, "utf8"), concurrent)
})

test("rejects an unmanaged matching entry without a verified rollback anchor", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const unmanaged = {
    ...value.config,
    plugins: [
      "existing-plugin",
      { package: value.pluginPath, options: scriptOptions },
    ],
  }
  await fs.writeFile(value.configPath, `${JSON.stringify(unmanaged, null, 2)}\n`)

  await assert.rejects(
    install({
      configPath: value.configPath,
      pluginPath: value.pluginPath,
      ...scriptOptions,
    }),
    /rollback unavailable/,
  )
})

test("preserves published rollback evidence when automatic restoration fails", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const rollbackPath = `${value.configPath}.durable-knowledge-rollback.json`
  const failingIO = {
    ...fs,
    async open(target: fs.PathLike, flags: string | number, mode?: number) {
      if (String(target) === value.root && flags === "r") {
        const handle = await fs.open(target, flags)
        return {
          async sync() {
            throw new Error("simulated directory sync failure")
          },
          async close() {
            await handle.close()
          },
        }
      }
      return await fs.open(target, flags, mode)
    },
    async rename(source: fs.PathLike, target: fs.PathLike) {
      if (String(source).includes(".restore-")) {
        throw new Error("simulated restoration failure")
      }
      await fs.rename(source, target)
    },
  }

  await assert.rejects(
    install(
      {
        configPath: value.configPath,
        pluginPath: value.pluginPath,
        ...scriptOptions,
      },
      failingIO,
    ),
    /rollback metadata/,
  )

  const rollback = JSON.parse(await fs.readFile(rollbackPath, "utf8"))
  assert.equal(rollback.configPath, value.configPath)
  assert.equal(await fs.readFile(rollback.backupPath, "utf8"), value.original)
})

test("reports retained evidence when previous rollback metadata cannot be restored", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const rollbackPath = `${value.configPath}.durable-knowledge-rollback.json`
  await fs.writeFile(rollbackPath, "previous rollback metadata\n", { mode: 0o600 })
  let directorySyncs = 0
  const failingIO = {
    ...fs,
    async open(target: fs.PathLike, flags: string | number, mode?: number) {
      if (String(target) === value.root && flags === "r") {
        const handle = await fs.open(target, flags)
        return {
          async sync() {
            directorySyncs += 1
            if (directorySyncs === 1) throw new Error("initial sync failed")
            await handle.sync()
          },
          async close() {
            await handle.close()
          },
        }
      }
      return await fs.open(target, flags, mode)
    },
    async rename(source: fs.PathLike, target: fs.PathLike) {
      if (String(source).includes(".previous-")) {
        throw new Error("previous metadata restore failed")
      }
      await fs.rename(source, target)
    },
  }

  await assert.rejects(
    install(
      {
        configPath: value.configPath,
        pluginPath: value.pluginPath,
        ...scriptOptions,
      },
      failingIO,
    ),
    /rollback metadata/,
  )

  assert.equal(await fs.readFile(value.configPath, "utf8"), value.original)
  const retained = JSON.parse(await fs.readFile(rollbackPath, "utf8"))
  assert.equal(await fs.readFile(retained.backupPath, "utf8"), value.original)
  const previousRecovery = (await fs.readdir(value.root)).find((entry) =>
    entry.includes(".previous-"),
  )
  assert.ok(previousRecovery)
  assert.equal(
    await fs.readFile(path.join(value.root, previousRecovery), "utf8"),
    "previous rollback metadata\n",
  )
})

test("fsyncs the directory after restoring previous rollback metadata", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const rollbackPath = `${value.configPath}.durable-knowledge-rollback.json`
  await fs.writeFile(rollbackPath, "previous rollback metadata\n", { mode: 0o600 })
  let directorySyncs = 0
  const failingOnceIO = {
    ...fs,
    async open(target: fs.PathLike, flags: string | number, mode?: number) {
      if (String(target) === value.root && flags === "r") {
        const handle = await fs.open(target, flags)
        return {
          async sync() {
            directorySyncs += 1
            if (directorySyncs === 1) throw new Error("initial sync failed")
            await handle.sync()
          },
          async close() {
            await handle.close()
          },
        }
      }
      return await fs.open(target, flags, mode)
    },
  }

  await assert.rejects(
    install(
      {
        configPath: value.configPath,
        pluginPath: value.pluginPath,
        ...scriptOptions,
      },
      failingOnceIO,
    ),
    /installation failed/,
  )

  assert.equal(directorySyncs, 3)
  assert.equal(await fs.readFile(value.configPath, "utf8"), value.original)
  assert.equal(await fs.readFile(rollbackPath, "utf8"), "previous rollback metadata\n")
})

test("CLI error formatting preserves only sanitized recovery paths", () => {
  assert.equal(
    installErrorMessage(
      new Error(
        "installation failed; rollback metadata: /safe/rollback.json; backup: /safe/backup.json",
      ),
    ),
    "installation failed; rollback metadata: /safe/rollback.json; backup: /safe/backup.json",
  )
  assert.equal(
    installErrorMessage(new Error("SECRET_CONFIG_CONTENT")),
    "durable knowledge installation failed",
  )
})

test("leaves the original unchanged when input validation fails", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))

  await assert.rejects(
    install({
      configPath: value.configPath,
      pluginPath: "relative/plugin",
      ...scriptOptions,
    }),
    /invalid installer input/,
  )

  assert.equal(await fs.readFile(value.configPath, "utf8"), value.original)
})

test("leaves the original unchanged when atomic rename fails", async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const failingIO = {
    ...fs,
    async rename() {
      throw new Error("simulated rename failure")
    },
  }
  const previousRollback = `${value.configPath}.durable-knowledge-rollback.json`
  await fs.writeFile(previousRollback, "previous rollback metadata\n", { mode: 0o600 })

  await assert.rejects(
    install(
      {
        configPath: value.configPath,
        pluginPath: value.pluginPath,
        ...scriptOptions,
      },
      failingIO,
    ),
    /installation failed/,
  )

  assert.equal(await fs.readFile(value.configPath, "utf8"), value.original)
  assert.equal(await fs.readFile(previousRollback, "utf8"), "previous rollback metadata\n")
  assert.equal(
    (await fs.readdir(value.root)).some((name) => name.includes(".tmp-")),
    false,
  )
})
