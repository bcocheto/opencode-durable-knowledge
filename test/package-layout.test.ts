import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { Host } from "@opencode/plugin/host"

test("package entrypoint loads the TypeScript build through root index.js", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"))
  const tsconfig = JSON.parse(await fs.readFile("tsconfig.json", "utf8"))

  assert.equal(packageJson.main, "./index.js")
  assert.equal(packageJson.exports, "./index.js")
  assert.equal(await fs.readFile("index.js", "utf8"), 'export { default } from "./dist/index.js"\n')
  assert.equal(tsconfig.compilerOptions.rootDir, "src")
  assert.equal(tsconfig.compilerOptions.outDir, "dist")
})

test("OpenCode V2 resolves the canonical checkout as a local plugin directory", () => {
  const entrypoint = Host.resolve({ directory: process.cwd() }).server

  assert.ok(entrypoint)
  assert.equal(fileURLToPath(entrypoint), `${process.cwd()}/index.js`)
})
