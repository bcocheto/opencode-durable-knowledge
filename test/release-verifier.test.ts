import assert from "node:assert/strict"
import test from "node:test"

import {
  validateArtifactFiles,
  validatePublicContents,
} from "../scripts/verify-release.mjs"

const approvedFiles = [
  "index.js",
  "package.json",
  "README.md",
  "LICENSE",
  "docs/PYTHON_POLICY_CONTRACT.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/index.js.map",
]

test("accepts the approved npm artifact layout", () => {
  assert.deepEqual(validateArtifactFiles(approvedFiles), [])
})

test("rejects internal planning files without reflecting their path", () => {
  assert.deepEqual(
    validateArtifactFiles([...approvedFiles, "docs/superpowers/private-plan.md"]),
    ["unexpected package path"],
  )
})

test("rejects a package missing its root OpenCode entrypoint", () => {
  assert.deepEqual(
    validateArtifactFiles(approvedFiles.filter((path) => path !== "index.js")),
    ["missing required package path"],
  )
})

test("rejects private home paths without reflecting content", () => {
  const privatePath = ["", "home", "bcocheto", "private", "policy.py"].join("/")
  assert.deepEqual(
    validatePublicContents([
      { path: "README.md", content: `Policy: ${privatePath}` },
    ]),
    ["private content detected"],
  )
})

test("rejects common credential assignments without reflecting content", () => {
  const credential = `${["GITHUB", "TOKEN"].join("_")}=${[
    "ghp",
    "exampleSecret123",
  ].join("_")}`
  assert.deepEqual(
    validatePublicContents([
      { path: "README.md", content: credential },
    ]),
    ["private content detected"],
  )
})

test("accepts generic public package content", () => {
  assert.deepEqual(
    validatePublicContents([
      {
        path: "README.md",
        content: "Use /absolute/path/to/policy.py and keep credentials private.",
      },
    ]),
    [],
  )
})
