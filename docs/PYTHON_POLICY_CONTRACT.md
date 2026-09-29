# Python Policy Contract

`opencode-durable-knowledge` is an adapter, not a policy engine. It starts three user-supplied scripts as direct child processes and exchanges JSON through stdin/stdout.

The filenames below describe roles; your configured files may use other names.

## Common subprocess rules

- `pythonExecutable` and every script path must be absolute.
- The process is invoked as `pythonExecutable script [args...]` without a shell.
- Stdin contains one UTF-8 JSON object and is limited to 256 KiB.
- Stdout must contain one UTF-8 JSON object and is limited to 256 KiB.
- Stderr is drained but never retained or surfaced by the plugin.
- The configured timeout applies to every invocation and cannot exceed 60 seconds.
- Timeout or cancellation terminates the process group.
- Unknown, malformed, oversized, or privacy-expanding output is rejected.

The policy implementation owns vault discovery, canonical routing, privacy rules, duplicate handling, transactions, receipts, readback, and any private state. The plugin never accesses `.obsidian/`.

## `knowledge_context.py`

The context script is called once per session with `hook_event_name: "SessionStart"` and once per ordinary user prompt with `hook_event_name: "UserPromptSubmit"`.

Session-start input:

```json
{
  "session_id": "ses_...",
  "turn_id": "msg_...",
  "cwd": "/absolute/path/to/project",
  "hook_event_name": "SessionStart"
}
```

Prompt input adds the raw current prompt:

```json
{
  "session_id": "ses_...",
  "turn_id": "msg_...",
  "cwd": "/absolute/path/to/project",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "current user prompt"
}
```

Required output with exit code `0`:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "bounded pointers or policy guidance"
  }
}
```

`additionalContext` must be a non-empty string no longer than 7,200 characters. Context failures produce a fixed manual-review warning; they never claim persistence.

## `knowledge_capture.py`

The capture script has two modes. Both accept exit code `0` for success and exit code `2` for a structured blocked result.

### Durable capture

Input:

```json
{
  "session_id": "ses_...",
  "turn_id": "msg_...",
  "prompt_sha256": "64 lowercase hex characters",
  "kind": "architecture",
  "project": "Example",
  "title": "Decision title",
  "status": "accepted",
  "rule": "The approved durable rule.",
  "scope": "Where it applies.",
  "exceptions": [],
  "consequences": [],
  "approval_source": "OpenCode explicit approval signal",
  "target_path": null,
  "supersedes_path": null,
  "successor_path": null
}
```

`status` is one of `proposed`, `accepted`, `superseded`, or `rejected`. The plugin derives correlation fields from the active OpenCode transcript; callers cannot supply them through the tool schema.

Successful output must contain exactly these fields:

```json
{
  "status": "success",
  "classification": "durable",
  "receipt_id": "64 lowercase hex characters",
  "paths": ["Knowledge/relative-note.md"]
}
```

`paths` must contain 1–8 safe vault-relative paths. The policy should emit success only after its write, receipt, and readback requirements are satisfied.

### Transient classification

The same script is invoked with `--classify-transient`.

Input:

```json
{
  "session_id": "ses_...",
  "turn_id": "msg_...",
  "prompt_sha256": "64 lowercase hex characters",
  "justification": "Why this turn creates no durable rule."
}
```

Successful output must contain exactly:

```json
{
  "status": "success",
  "classification": "none",
  "paths": []
}
```

### Structured block

Either capture mode may return exit code `2` with exactly:

```json
{
  "status": "blocked",
  "classification": "blocked",
  "reason": "Sanitized explanation, at most 1200 characters.",
  "rollback": "not_required"
}
```

`rollback` must be one of `not_started`, `not_required`, `complete`, or `incomplete`. Never include secrets, raw prompts, subprocess diagnostics, or private absolute paths in `reason`.

## `knowledge_stop_review.py`

The completed-turn review script receives:

```json
{
  "session_id": "ses_...",
  "turn_id": "msg_...",
  "cwd": "/absolute/path/to/project",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "assistant text before the matching idle boundary"
}
```

Return exit code `0` and a JSON object. To request one corrective continuation, return:

```json
{
  "decision": "block",
  "reason": "Sanitized corrective instruction, at most 1200 characters."
}
```

Any result without both `decision: "block"` and a valid non-empty `reason` is treated as no correction. If a marked continuation remains unresolved, the script is called once more with `stop_hook_active: true`; the plugin does not queue another continuation.

Review output must not contain credentials, raw subprocess diagnostics, or private state. A failed review is ignored rather than blocking work blindly.
