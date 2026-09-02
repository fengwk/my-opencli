# chatgpt-agent (OpenCLI plugin)

Protocol-first ChatGPT web adapter:

1. Arm WS capture → send composer message  
2. Collect stream text / sandbox files / image gen pointers  
3. Files: human-like chip / flyout Download via `waitForDownload`  
4. Images: official-style DOM export (fetch/canvas → local files)  
5. Uploads: sequential `setFileInput` (path) — native CDP path only, no DataTransfer / base64 fallback  
6. Managed collect: Chrome downloads are remapped (`C:\...` → `/mnt/c/...` on WSL) and copied into `--op` (`path` / `collected` / `collectedFrom` / `bytes`)

## Session & concurrency model

- `chatgpt-agent ask` does not declare `persistent`, relying on OpenCLI's default ephemeral site session: overlapping runs get separate logical tab leases, while sequential runs may reuse an idle cleared physical placeholder tab.
- Login state (profile / cookies) is shared across tabs from the same browser profile.
- Conversation continuity is provided by `--session <conversationId>`, not by pinning a persistent tab. Serializing concurrent writes to the same conversation is the caller's responsibility.
- Parallel file downloads require the paired extension's tab-scoped download wait (`>=1.0.31`).

## Requirements

| Host | Minimum | Current verified release |
|------|---------|--------------------------|
| `@jackwener/opencli` (fork) | `>=1.8.7` | package `1.8.7-fengwk.10` (git tag `fork-v1.8.7-fengwk.10`) |
| Browser Bridge / Extension | **`>=1.0.31`** | paired Extension **`1.0.31`** | CDP/WS capture + tab-scoped download behavior must match the CLI |

Needs fork APIs: `page.startWsCapture` / `page.readWsCapture`, hardened `page.setFileInput`, and optional `Arg.repeatable` for multi `--file`.

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
