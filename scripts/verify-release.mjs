import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REQUIRED_FILES = [
  "index.js",
  "package.json",
  "README.md",
  "LICENSE",
  "docs/PYTHON_POLICY_CONTRACT.md",
  "dist/index.js",
  "dist/index.d.ts",
]

const ALLOWED_ROOT_FILES = new Set([
  "index.js",
  "package.json",
  "README.md",
  "LICENSE",
  "docs/PYTHON_POLICY_CONTRACT.md",
])

const PRIVATE_CONTENT = [
  /\/home\/bcocheto(?:\/|$)/u,
  /Documentos\/Obsidian Vault/u,
  /\.codex\/hooks/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[\s"'`])(?:GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|PASSWORD|SECRET)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}/imu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
]

function isAllowedPath(file) {
  return (
    ALLOWED_ROOT_FILES.has(file) ||
    (/^dist\//u.test(file) && /(?:\.js|\.js\.map|\.d\.ts)$/u.test(file))
  )
}

export function validateArtifactFiles(files) {
  const errors = []
  if (files.some((file) => typeof file !== "string" || !isAllowedPath(file))) {
    errors.push("unexpected package path")
  }
  if (REQUIRED_FILES.some((required) => !files.includes(required))) {
    errors.push("missing required package path")
  }
  return errors
}

export function validatePublicContents(entries) {
  return entries.some(
    (entry) =>
      typeof entry?.content !== "string" ||
      PRIVATE_CONTENT.some((pattern) => pattern.test(entry.content)),
  )
    ? ["private content detected"]
    : []
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"

  execFileSync(npm, ["run", "build"], { cwd: root, stdio: "inherit" })
  const packed = execFileSync(
    npm,
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  )
  const report = JSON.parse(packed)
  const files = report?.[0]?.files?.map((file) => file.path)
  if (!Array.isArray(files)) throw new Error("release verification failed: invalid npm output")

  const contents = files.map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(root, file), "utf8"),
  }))
  const errors = [
    ...validateArtifactFiles(files),
    ...validatePublicContents(contents),
  ]
  if (errors.length > 0) {
    throw new Error(`release verification failed: ${[...new Set(errors)].join(", ")}`)
  }
  process.stdout.write(`${JSON.stringify({ status: "success", files: files.length })}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    run()
  } catch {
    process.stderr.write("release verification failed\n")
    process.exitCode = 1
  }
}
