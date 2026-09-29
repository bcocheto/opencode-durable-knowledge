# OpenCode Durable Knowledge

[![npm version](https://img.shields.io/npm/v/opencode-durable-knowledge.svg)](https://www.npmjs.com/package/opencode-durable-knowledge)
[![license](https://img.shields.io/npm/l/opencode-durable-knowledge.svg)](LICENSE)

OpenCode V2 plugin that connects prompt, tool, and completed-turn lifecycle events to an external, verifiable Obsidian knowledge policy. Markdown in your vault remains canonical; the plugin does not create a second memory store.

> **Adapter package:** this repository does not include a vault or the Python policy implementations. You must provide three compatible local scripts. See [Python policy contract](docs/PYTHON_POLICY_CONTRACT.md).

## What it does

```text
OpenCode prompt/context hooks ─┐
OpenCode capture tools ────────┼─> bounded JSON subprocess adapter
OpenCode completed-turn events ┘             │
                                             ├─ knowledge_context.py
                                             ├─ knowledge_capture.py
                                             └─ knowledge_stop_review.py
```

- Requests bounded knowledge pointers before model work.
- Adds `durable_knowledge.capture` for explicitly approved durable decisions.
- Adds `durable_knowledge.classify_transient` for ambiguous but non-durable work.
- Correlates each tool call to native OpenCode session and message IDs plus a prompt SHA-256.
- Reviews successful completed turns and can queue at most one marked corrective continuation.
- Leaves routing, duplicate detection, sensitive-material policy, writes, receipts, and readback to your Python policy.

## Requirements

- OpenCode V2 `2.0.19`
- Node.js 22 or newer
- Python 3 at an absolute path
- Compatible context, capture, and completed-turn review scripts
- A vault and any private policy state expected by those scripts

Obsidian itself is not required for the subprocess bridge. Other integrations, such as an Obsidian MCP server, may require the application to be open.

## Install

Install the exact release globally with the OpenCode V2 CLI:

```sh
opencode plugin add opencode-durable-knowledge@0.1.0
```

Then replace the package's string entry in your global `opencode.json` with object-form configuration so the required script paths are available:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-durable-knowledge@0.1.0",
      "options": {
        "pythonExecutable": "/absolute/path/to/python3",
        "contextScript": "/absolute/path/to/knowledge_context.py",
        "captureScript": "/absolute/path/to/knowledge_capture.py",
        "stopReviewScript": "/absolute/path/to/knowledge_stop_review.py",
        "timeoutMs": 20000
      }
    }
  ]
}
```

All four executable/script paths are required and must be absolute. `timeoutMs` defaults to `20000` and must be a positive integer no greater than `60000`.

After reloading OpenCode, use `opencode plugin list` to confirm that `bcocheto.durable-knowledge` is active.

## Python policy contract

The TypeScript package provides OpenCode-specific wiring only. Your scripts receive one JSON object on stdin and return one JSON object on stdout. Capture operations use exit code `0` for success and may use exit code `2` for a structured blocked result. Context and completed-turn review operations use exit code `0`.

See [docs/PYTHON_POLICY_CONTRACT.md](docs/PYTHON_POLICY_CONTRACT.md) for the complete payload and result shapes.

## Security boundaries

- JSON stdin and stdout are each limited to 256 KiB.
- Subprocesses run without shell interpolation.
- Timeout or cancellation terminates the Python process group with a bounded settlement fallback.
- Subprocess stderr is drained but never retained, returned to the model, or persisted by the plugin.
- The plugin keeps no prompt or transcript bodies in durable storage.
- The plugin never reads or writes `.obsidian/`.
- All vault writes occur through your capture policy.
- Capture failures fail closed. Context/review failures do not claim persistence and do not create continuation loops.
- Credentials do not belong in plugin options, policy output, or this repository.

The context script receives the current user prompt because retrieval may depend on it. The adapter holds that value only in bounded in-memory session state and sends it to the configured local subprocess; it does not persist it.

## Completed-turn review limitation

OpenCode V2 does not expose a synchronous equivalent of a blocking `Stop` hook. This plugin consumes durable `session.execution.succeeded` events and reviews the assistant response before the exact persisted idle boundary represented by that event.

If the policy reports missing evidence, the plugin can queue one marked continuation. A second unresolved review is reported to the policy with `stop_hook_active: true` and cannot queue another continuation. This is a post-turn corrective gate, not a guarantee that the first response is withheld.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build emits `dist/`; root `index.js` is the package and local-directory entrypoint expected by OpenCode V2.

## Compatibility

Version `0.1.0` is tested against OpenCode V2 `2.0.19`. The plugin API is version-pinned because OpenCode V2 lifecycle and tool contracts can change between releases.

## License

[MIT](LICENSE)
