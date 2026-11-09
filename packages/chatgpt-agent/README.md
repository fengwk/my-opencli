# chatgpt-agent (OpenCLI plugin)

Protocol-first ChatGPT web adapter:

1. Arm HTTP-stream + WS capture → send composer message
2. Collect stream text / sandbox files / image gen pointers
3. Files: human-like chip / flyout Download via `waitForDownload`
4. Images: select current-turn gallery images, then use ChatGPT viewer → Download → `Download image` with `waitForDownload`
5. Uploads: sequential `setFileInput` (path) — native CDP path only, no DataTransfer / base64 fallback
6. Managed collect: receipt-proven Chrome downloads are remapped (`C:\...` → `/mnt/c/...` on WSL) and copied into `--op`

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

### Pre-send readiness and resume safety

- Readiness supports both legacy message attributes and the current turn/search-unit DOM. A conversation must have a visible composer and at least one rendered message/turn marker; UI text length alone is not evidence of loaded history.
- With `--session`, the active ChatGPT conversation ID must match the requested ID. An inaccessible conversation, a redirect to a new chat, or an unreadable URL never falls back to the supplied ID and never receives a prompt.
- Hydration is polled every 500 ms for up to 15 seconds, with at most one page-health reload and another 15-second hydration window. These windows exclude navigation/transport time and are separate from the turn's `--timeout`.
- The surface is checked again after idle recovery, before draft cleanup or uploads, and once more before capture/send. If still hydrating, each check gets one polling window without another reload. A final URL check guards redirects during capture setup.
- `PAGE_BROKEN` includes message-marker count, main-text length, blank-thread, session-mismatch and unavailable-conversation flags, without echoing prompt/history text. Definite unavailable-conversation notices fail before sending; submission itself is never automatically retried.

### DOM compatibility (Uploads & File Downloads)

- **Composer & Upload Inputs**: Supports modern `form[data-chatgpt-composer]` and `.ProseMirror[contenteditable="true"][role="textbox"]` alongside legacy `#prompt-textarea`. File inputs in the composer form are selected semantically by `aria-label` (`Attach files` / `Attach photos`), strictly preventing general files from being routed to `Take a photo`, with safe fallbacks to legacy IDs.
- **Upload Preview Verification**: Bounded strictly to the visible composer form/root scope. Body-wide text or avatar thumbnails never trigger false-positive upload completion.
- **Last Assistant Turn Identification**: Accurately bounds file downloads to the last assistant turn using modern role/search-unit attributes (`data-chatgpt-search-unit-key*=":assistant"`, `data-conversation-role="assistant"`) and legacy author-role attributes. Never uses prose text to guess roles, strictly isolates against user messages or prior history turns, and merges nested wrappers to avoid empty container traps or duplicate turn splits.
- **File Downloads & Resource Rows**: Supports modern ChatGPT resource rows (`.group/resource-row` with preview button and hover `Download file` button), legacy flyout panels (`section[data-testid="screen-threadFlyOut"]`), and legacy direct file chips (`button.behavior-btn` and sandbox `<a>` links).
  - Modern resource rows: focuses the preview button to expose the download button and clicks `Download file` directly without opening the preview or polling legacy flyouts (`mode: 'resource-row'`).
  - Strict isolation: files are resolved strictly within the latest assistant turn, guaranteeing row isolation between different files and rejecting user/history decoys.
  - Race elimination: `page.waitForDownload` is armed before clicking any download trigger across all paths (`resource-row`, `panel`, `chip-direct`).
  - Strict sandbox evidence: arbitrary external links are strictly rejected.

### Generated-image gallery compatibility

- Generated-image export requires non-empty protocol image `messageId` values. It only targets galleries whose nearest `data-chatgpt-search-message-ids` scope matches those IDs; missing IDs, historical galleries, user uploads, and ambiguous targets fail closed.
- Multi-image galleries are selected in `Generated images` side-rail order. Each rail selection is verified against its selected preview before opening the viewer. A single preview without a rail is allowed only inside one unambiguous scoped gallery.
- Each image uses the viewer's `Download` menu trigger and the exact `Download image` menu item; `waitForDownload` is armed before the final CDP click. The completed Chrome receipt's local file is validated as a non-empty image and copied to `--op`. Results retain `kind: image-export` and report `method: chrome-download`, the original filename, download id, managed path, byte count and SHA-256.
- Image bytes never pass through the daemon command or response. There is no image Base64 extraction, host asset fetch, or fallback export path.
- Downloads use the caller's remaining timeout for discovery, UI actions and the receipt waiter. On incomplete output, the validated persisted conversation may be remounted once without resubmitting the prompt. Successful files are retained across the remount and already completed indices are skipped.

### Hub file boundary

- Input: the Skill uploads attachments with Hub multipart resources first. Execution argv references `/resources/...`; Hub resolves it to an execution-host path. `uploadComposerFiles` passes that path to `page.setFileInput`, and Chrome reads the file through native CDP. Do not embed attachment bytes in command JSON.
- Output: the plugin writes artifacts into `--op`, which Hub injects as a per-execution directory, then Hub scans it and returns resource download URLs. Both generated images and ordinary files use Chrome's native download path and are copied into `--op`; image bytes are not sent through command argv or daemon control responses. Clients obtain those files through Hub resource HTTP downloads.
- The Hub/CLI/Chrome deployment needs a shared filesystem for path-based upload and native-download collection. A browser on another host needs an explicit file-transfer facility; passing the caller's local path is not enough.

## Requirements

| Host | Minimum | Current verified release |
|------|---------|--------------------------|
| `@jackwener/opencli` (fork) | `>=2.0.2-fengwk.6` | `2.0.2-fengwk.6` (`fork-v2.0.2-fengwk.6`) |
| Browser Bridge / Extension | **`>=1.0.35`** | published pair **`1.0.39`**; native downloads also verified with **`1.0.38`** |

Needs fork APIs: `page.startSseCapture` / `page.readSseCapture` (HTTP stream capture) and `page.startWsCapture` / `page.readWsCapture` (WebSocket capture), hardened `page.setFileInput`, and optional `Arg.repeatable` for multi `--file`. The CLI/CLI-extension pair must both ship HTTP stream capture: the extension arms it per request and the CLI drains it, so a mismatched pair fails the turn before the prompt is sent.

Native gallery downloads also require the CLI `2.0.2-fengwk.6` click hit-test fix: ordinary ancestor pseudo-overlays must not count as proof that native input reaches a child button. Update the installed CLI before this plugin; publishing releases alone does not update Hub's persisted plugin tree.

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
