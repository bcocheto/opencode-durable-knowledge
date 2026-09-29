import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"

const manifest = JSON.parse(await fs.readFile("package.json", "utf8"))

test("publishes the approved package identity and repository metadata", () => {
  assert.equal("private" in manifest, false)
  assert.equal(manifest.name, "opencode-durable-knowledge")
  assert.equal(manifest.version, "0.1.0")
  assert.equal(manifest.license, "MIT")
  assert.equal(manifest.author, "bcocheto")
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/bcocheto/opencode-durable-knowledge.git",
  })
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/bcocheto/opencode-durable-knowledge/issues",
  })
  assert.equal(
    manifest.homepage,
    "https://github.com/bcocheto/opencode-durable-knowledge#readme",
  )
  assert.deepEqual(manifest.publishConfig, { access: "public" })
})

test("limits the npm artifact to runtime and public documentation", () => {
  assert.deepEqual(manifest.files, [
    "index.js",
    "dist",
    "README.md",
    "LICENSE",
    "docs/PYTHON_POLICY_CONTRACT.md",
  ])
  assert.equal(manifest.main, "./index.js")
  assert.equal(manifest.exports, "./index.js")
  assert.equal(manifest.types, "./dist/index.d.ts")
})

test("builds immediately before npm creates a release artifact", () => {
  assert.equal(manifest.scripts.prepack, "npm run build")
})

test("ships complete public documentation without private home paths", async () => {
  const paths = ["LICENSE", "README.md", "docs/PYTHON_POLICY_CONTRACT.md"]
  const contents = new Map<string, string>()

  for (const path of paths) {
    const content = await fs.readFile(path, "utf8").catch(() => undefined)
    assert.notEqual(content, undefined, `${path} must exist`)
    assert.doesNotMatch(content!, /\/home\/bcocheto/u)
    contents.set(path, content!)
  }

  assert.match(contents.get("LICENSE")!, /MIT License/u)
  assert.match(
    contents.get("README.md")!,
    /opencode plugin add opencode-durable-knowledge@0\.1\.0/u,
  )
  assert.match(
    contents.get("README.md")!,
    /"package": "opencode-durable-knowledge@0\.1\.0"/u,
  )

  const contract = contents.get("docs/PYTHON_POLICY_CONTRACT.md")!
  assert.match(contract, /knowledge_context\.py/u)
  assert.match(contract, /knowledge_capture\.py/u)
  assert.match(contract, /knowledge_stop_review\.py/u)
})
