# my-opencli

Personal OpenCLI plugins, installed via the official plugin mechanism.

## Plugins

| Name | Path | Description |
|------|------|-------------|
| `utils` | `packages/utils` | Host-Chrome utilities; `opencli utils scrape` fetches pages in the background by default with my-mcp HTML/markdown cleaning |
| `chatgpt-agent` | `packages/chatgpt-agent` | Protocol-stream ChatGPT agent (WS text/files/images, sequential upload, DOM file download, official-style image export) |
| `gemini-agent` | `packages/gemini-agent` | Protocol-stream Gemini agent (StreamGenerate text/images, sequential upload, native generated-image download) |
| `jimeng-agent` | `packages/jimeng-agent` | Jimeng Agent video drafts on Generate and AI Canvas (checkpointed prepare/`--submit`, exact resource correlation, status search, official download) |

## Requirements (fork)

These plugins **require an OpenCLI fork**, not stock upstream alone:

| Component | Minimum | Current verified release | Why |
|-----------|---------|--------------------------|-----|
| Node.js | **`>=20.18.1`** | `24.14.0` | Matches OpenCLI and Cheerio runtime engines |
| CLI (`@jackwener/opencli`) | **`>=1.8.7`** | package `1.8.7-fengwk.11` (git tag `fork-v1.8.7-fengwk.11`) | Browser window/session controls, network/frame APIs, WS capture, hardened file input, `Arg.repeatable` |
| Browser Bridge / Extension | **`>=1.0.32`** | paired Extension **`1.0.32`** | Browser/frame/CDP/WS capture, tab-scoped downloads, and ephemeral warm-tab reuse must match the CLI |

Minimum ranges are the compatibility floor; the verified columns name the paired fork Release that has been published and checked. Package version (`1.8.7-fengwk.11`) and git tag (`fork-v1.8.7-fengwk.11`) are related but not the same string — do not treat the package version as a tag name.

Install and reload **both** the forked CLI and its matching Browser Bridge / Extension. Mismatched CLI/extension pairs will fail at runtime even if the plugin installs cleanly.
`gemini-agent` specifically requires Browser Bridge `1.0.30` for raw CDP input, network capture, hardened file input, and download lifecycle support.

See your OpenCLI fork’s `FORK.md` for packaging details.

## Install

### Local (development)

Exact local install from the subplugin package path:

```bash
# from this repo root (adjust clone path if different)
REPO="$(pwd)"

opencli plugin uninstall chatgpt-agent 2>/dev/null || true
opencli plugin uninstall gemini-agent 2>/dev/null || true
opencli plugin uninstall jimeng-agent 2>/dev/null || true
opencli plugin uninstall utils 2>/dev/null || true
# Local installs use the standalone subplugin path (not the monorepo root).
opencli plugin install "${REPO}/packages/chatgpt-agent"
opencli plugin install "${REPO}/packages/gemini-agent"
opencli plugin install "${REPO}/packages/jimeng-agent"
opencli plugin install "${REPO}/packages/utils"

# verify
opencli plugin list
opencli chatgpt-agent ask --help
opencli gemini-agent ask --help
opencli jimeng-agent video --help
opencli jimeng-agent canvas-create --help
opencli jimeng-agent canvas-video --help
opencli jimeng-agent canvas-status --help
opencli utils scrape --help
```

Re-install after plugin code changes when not using a live local path (see `opencli plugin list`).

### Hub / remote (GitHub)

Install individual subplugins from this GitHub repo:

```bash
opencli plugin uninstall chatgpt-agent 2>/dev/null || true
opencli plugin install github:fengwk/my-opencli/chatgpt-agent
opencli plugin uninstall gemini-agent 2>/dev/null || true
opencli plugin install github:fengwk/my-opencli/gemini-agent
opencli plugin uninstall jimeng-agent 2>/dev/null || true
opencli plugin install github:fengwk/my-opencli/jimeng-agent
opencli plugin uninstall utils 2>/dev/null || true
opencli plugin install github:fengwk/my-opencli/utils

opencli plugin list
opencli chatgpt-agent ask --help
opencli gemini-agent ask --help
opencli jimeng-agent video --help
opencli jimeng-agent canvas-create --help
opencli jimeng-agent canvas-video --help
opencli jimeng-agent canvas-status --help
opencli utils scrape --help
```

Equivalent monorepo install (all enabled subplugins):

```bash
opencli plugin install github:fengwk/my-opencli
```

### Version pinning limitation (important)

Official OpenCLI `plugin install` / `plugin update` currently clones/pulls the remote **default branch** only. There is **no supported way yet to pin a git tag or ref** for plugin sources.

Consequences:

- A Hub/remote install always tracks whatever is currently on the default branch tip.
- **Fresh deployments are not reproducible** from a release tag alone until OpenCLI gains ref/tag support for plugins.
- GitHub Releases / `v*` tags in this repo document a known-good tree for humans and CI, but they are **not** consumable as install pins today.

Prefer a **local path install** when you need a fixed tree for development or production.

### `plugins.lock.json`

After install/update, OpenCLI records sources and the resolved **git commit** under `~/.opencli/plugins.lock.json`. `opencli plugin list` may show a short commit hash when that metadata exists.

Notes:

- The lock file is **host-local** (under `~/.opencli/`), not something this plugin repo publishes.
- Commit hashes are observational — they describe what landed on the machine after following the default branch. They do **not** restore reproducibility across machines until install can target a ref.
- Do not treat lock entries as a substitute for pinning; reinstall/update can move with the remote default branch.

## Usage

```bash
# scrape a URL in the host Chrome without stealing the current tab
opencli utils scrape https://example.com --only-main-content true --window background

# text
opencli chatgpt-agent ask '用一句话说明今天天气如何' --timeout 180

# continue session
opencli chatgpt-agent ask '继续' --session <conversationId>

# Gemini text / image (protocol StreamGenerate)
opencli gemini-agent ask '用一句话说明 Docker 是做什么的' --timeout 180
opencli gemini-agent ask '画一只坐在窗台上的橘猫' --op "/absolute/path/to/gemini-output"
opencli gemini-agent ask '概括附件' --file "/absolute/path/to/notes.txt"
opencli gemini-agent ask '继续补充两点' --session "<conversationId>"

# multi file (repeatable flags)
opencli chatgpt-agent ask '读这两个附件并概括' \
  --file ./a.txt \
  --file ./b.png

# images export dir
opencli chatgpt-agent ask '画一只猫' --op ~/Pictures/chatgpt-agent

# prepare a Jimeng Agent video draft (default --submit 0); result includes auto asset-id
opencli jimeng-agent video \
  --workspace <workspace-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0

# optional formal submit after checkpoint, then search/download by asset-id
opencli jimeng-agent video ... --submit 1
opencli jimeng-agent status --workspace <workspace-id> --search-key <asset-id> --download 1

# create a blank AI Canvas only and keep its project id for later runs
opencli jimeng-agent canvas-create --title '人物镜头测试'

# prepare inside the canvas created above (several clips can reuse one canvas)
opencli jimeng-agent canvas-video \
  --canvas <project-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --ratio 16:9 \
  --model-version seedance2.0

# prepare in a newly created AI Canvas (default --submit 0) and optionally name it
opencli jimeng-agent canvas-video \
  --canvas new \
  --title '人物镜头测试' \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --ratio 16:9 \
  --model-version seedance2.0

# inspect every Canvas resource, or correlate one canvas-video asset-id exactly
opencli jimeng-agent canvas-status --canvas <project-id>
opencli jimeng-agent canvas-status --canvas <project-id> --asset-id <asset-id>
```

### WSL + Windows Chrome

- Uploads under `/home/...` are **auto-staged** to `C:\Users\<user>\Downloads\opencli-upload\` so `setFileInput` can read them.
- Native Linux Chrome: no staging; paths used as-is.
- Override: `OPENCLI_UPLOAD_STAGE=0` disable / `=1` force.

## Develop / verify this repo

Root is a **private** workspace package (not published to npm). Node `>=20.18.1`.

```bash
npm ci
npm run check          # manifest + syntax validation, then unit tests
npm test               # vitest only
npm run validate       # opencli-plugin.json + package contracts + JS syntax
npm run validate:manifest
npm run validate:syntax
```

Release process (maintainers):

1. Keep the root package, lockfile, manifest, and all plugin package versions aligned.
2. Push tag **`v<opencli-plugin.json version>`** exactly (e.g. `v0.1.19`). Do **not** move an existing published tag such as `v0.1.0`.
3. GitHub Actions `release.yml` runs the same checks, verifies the tag string, then creates a **GitHub Release with generated notes**.
4. No `npm publish` and no binary artifacts — consumers install from git/path only. Remote install still follows the default branch (see **Version pinning limitation** above); tags document known-good trees but are not install pins.

## Relation to OpenCLI fork

Core runtime changes (WS capture, setFileInput harden, `repeatable` args) live in the OpenCLI **fork**.

This repo only holds **adapter plugins** that should stay out of upstream `clis/` when possible.
