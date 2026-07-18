# chatgpt-agent (OpenCLI plugin)

Protocol-first ChatGPT web adapter:

1. Arm WS capture → send composer message  
2. Collect stream text / sandbox files / image gen pointers  
3. Files: human-like chip / flyout Download via `waitForDownload`  
4. Images: official-style DOM export (fetch/canvas → local files)  
5. Uploads: sequential `setFileInput` (path) with DataTransfer fallback  

## Requirements

| Host | Minimum | Current verified release |
|------|---------|--------------------------|
| `@jackwener/opencli` (fork) | `>=1.8.7` | package `1.8.7-fengwk.2` (git tag `fork-v1.8.7-fengwk.2`) |
| Browser Bridge / Extension | `>=1.0.24` | paired Extension `1.0.24` |

Needs fork APIs: `page.startWsCapture` / `page.readWsCapture`, hardened `page.setFileInput`, and optional `Arg.repeatable` for multi `--file`.

Also depends on the host package’s built-in `clis/chatgpt/utils.js` (resolved at runtime via `host-chatgpt.js`).

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
