# my-opencli

Personal OpenCLI plugins, installed via the official plugin mechanism.

## Plugins

| Name | Path | Description |
|------|------|-------------|
| `chatgpt-agent` | `packages/chatgpt-agent` | Protocol-stream ChatGPT agent (WS text/files/images, sequential upload, DOM file download, official-style image export) |

## Install (local dev)

Requires a host OpenCLI that supports:

- `page.startWsCapture` / `page.readWsCapture`
- `page.setFileInput` (chooser intercept)
- optional: `Arg.repeatable` for multi `--file`

Typically your **fork** of OpenCLI (`~/proj/OpenCLI` on `dev`), installed globally.

```bash
# from anywhere
opencli plugin uninstall chatgpt-agent 2>/dev/null || true
# install from this repo (clone path; adjust if different)
opencli plugin install "$(pwd)/packages/chatgpt-agent"
# or monorepo root if your opencli supports multi-plugin manifests:
# opencli plugin install "$(pwd)"

# verify
opencli plugin list
opencli chatgpt-agent ask --help
```

Re-install after plugin code changes when not using a live local path (see `opencli plugin list`).

## Usage

```bash
# text
opencli chatgpt-agent ask '用一句话说明今天天气如何' --timeout 180

# continue session
opencli chatgpt-agent ask '继续' --session <conversationId>

# multi file (repeatable flags)
opencli chatgpt-agent ask '读这两个附件并概括' \
  --file ./a.txt \
  --file ./b.png

# images export dir
opencli chatgpt-agent ask '画一只猫' --op ~/Pictures/chatgpt-agent
```

### WSL + Windows Chrome

- Uploads under `/home/...` are **auto-staged** to `C:\Users\<user>\Downloads\opencli-upload\` so `setFileInput` can read them.
- Native Linux Chrome: no staging; paths used as-is.
- Override: `OPENCLI_UPLOAD_STAGE=0` disable / `=1` force.

## Relation to OpenCLI fork

Core runtime changes (WS capture, setFileInput harden, `repeatable` args) live in your OpenCLI **fork** (see that repo’s `FORK.md`).

This repo only holds **adapter plugins** that should stay out of upstream `clis/` when possible.
