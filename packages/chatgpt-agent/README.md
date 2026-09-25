# chatgpt-agent (OpenCLI plugin)

Protocol-first ChatGPT web adapter:

1. Arm HTTP-stream + WS capture → send composer message
2. Collect stream text / sandbox files / image gen pointers
3. Files: human-like chip / flyout Download via `waitForDownload`
4. Images: official-style DOM export (fetch/canvas → local files)
5. Uploads: sequential `setFileInput` (path) — native CDP path only, no DataTransfer / base64 fallback
6. Managed collect: Chrome downloads are remapped (`C:\...` → `/mnt/c/...` on WSL) and copied into `--op` (`path` / `collected` / `collectedFrom` / `bytes`)

## Turn stream transports

ChatGPT serves the turn itself as an HTTP SSE response
(`https://chatgpt.com/backend-api/f/conversation`), so that response is the
authoritative source for text, sources and turn completion; WebSockets stay
armed for the out-of-band updates (image/file messages). Both are captured
non-invasively through CDP — the page's own `fetch`/XHR are never patched.

- Capture is armed before the composer send and disarmed in the turn's `finally`; a missing CLI/extension arm fails before the prompt is sent.
- The captured bytes are decoded with a streaming UTF-8 decoder and parsed across arbitrary chunk/event boundaries (CRLF, comments, multi-line data).
- Once the turn's own response has started, only its terminal `[DONE]` frame ends the turn: a quiet or timed-out response is discarded (waiting out `--timeout` first) rather than returned as a truncated answer. A WebSocket-only empty terminal state is ignored for a bounded startup window, so the handshake frame cannot produce `EMPTY_REPLY`. Turns that never stream over HTTP keep their previous classification and timing.
- An incomplete stream never passes as success: evicted chunks, truncated payloads, a rejected arm, undecodable bytes, or a response that never terminated abort the turn with `SSE_CAPTURE_INCOMPLETE` / `SSE_CAPTURE_UNSUPPORTED` instead of returning partial text. Errors never echo captured content or the browser's raw failure text.
- `source` reports which transport delivered the turn (`sse` or `ws`).

## Attachment limits & capabilities

- **Attachment count**: at most 20 attachments per turn (validated and rejected before staging/upload).
- **Per-file size limits**:
  - Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): max 20 MiB per file.
  - CSV / spreadsheet files (`.csv`, `.tsv`, `.xls`, `.xlsx`): max 50 MiB per file.
  - All other files: max 512 MiB per file.
- **Document token limit**: ChatGPT service-side rule (up to ~2M tokens per document); documents are not read or tokenized locally.
- **Paths**: Quoted/generic absolute paths are recommended for agent invocations; relative paths remain accepted internally via `path.resolve` for backward compatibility.

## Session & concurrency model

- `chatgpt-agent ask` does not declare `persistent`, relying on OpenCLI's default ephemeral site session: overlapping runs get separate logical tab leases, while sequential runs may reuse an idle cleared physical placeholder tab.
- Login state (profile / cookies) is shared across tabs from the same browser profile.
- Conversation continuity is provided by `--session <conversationId>`, not by pinning a persistent tab. Serializing concurrent writes to the same conversation is the caller's responsibility.
- Parallel file downloads require the paired extension's tab-scoped download wait (`>=1.0.31`).

## Requirements

| Host | Minimum | Current verified release |
|------|---------|--------------------------|
| `@jackwener/opencli` (fork) | `>=1.8.8-fengwk.2` | local build `1.8.8-fengwk.2` (not published) |
| Browser Bridge / Extension | **`>=1.0.35`** | paired Extension **`1.0.35`** (local build, not published) |

Needs fork APIs: `page.startSseCapture` / `page.readSseCapture` (HTTP stream capture) and `page.startWsCapture` / `page.readWsCapture` (WebSocket capture), hardened `page.setFileInput`, and optional `Arg.repeatable` for multi `--file`. The CLI/CLI-extension pair must both ship HTTP stream capture: the extension arms it per request and the CLI drains it, so a mismatched pair fails the turn before the prompt is sent.

Also depends on the host package’s built-in `clis/chatgpt/utils.js`. `host-chatgpt.js` resolves it through the public `@jackwener/opencli/registry` export, so it works with the host symlink created by the official plugin installer even when package metadata is not exported.

## Install

**Local (exact path):**

```bash
opencli plugin install /path/to/my-opencli/packages/chatgpt-agent
```

**Hub / remote:**

```bash
opencli plugin install github:fengwk/my-opencli/chatgpt-agent
```

Official install/update follows the remote **default branch** only — tags/refs cannot be pinned yet, so remote installs are **not** bit-for-bit reproducible across time. Prefer a local path when you need a fixed tree. OpenCLI may record the resolved commit in `~/.opencli/plugins.lock.json` after install; that is machine-local metadata, not a pin.

See the [repo root README](../../README.md) for full fork, lockfile, and release notes.
