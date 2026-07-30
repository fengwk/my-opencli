# my-opencli

Personal OpenCLI plugins, installed via the official plugin mechanism.

## Plugins

| Name | Path | Description |
|------|------|-------------|
| `chatgpt-agent` | `packages/chatgpt-agent` | Protocol-stream ChatGPT agent (WS text/files/images, sequential upload, DOM file download, official-style image export) |
| `jimeng-agent` | `packages/jimeng-agent` | Jimeng Agent video drafts (rich `@` mentions, checkpointed prepare/`--submit`, status search, official download) |

## Requirements (fork)

This plugin **requires an OpenCLI fork**, not stock upstream alone:

| Component | Minimum | Current verified release | Why |
|-----------|---------|--------------------------|-----|
| CLI (`@jackwener/opencli`) | **`>=1.8.7`** | package `1.8.7-fengwk.2` (git tag `fork-v1.8.7-fengwk.2`) | `page.startWsCapture` / `page.readWsCapture`, hardened `page.setFileInput`, `Arg.repeatable` |
| Browser Bridge / Extension | **`>=1.0.24`** | paired Extension **`1.0.24`** | CDP/WS capture + file-chooser behavior must match the CLI |

Minimum ranges are the compatibility floor; the verified columns name the paired fork Release that has been published and checked. Package version (`1.8.7-fengwk.2`) and git tag (`fork-v1.8.7-fengwk.2`) are related but not the same string — do not treat the package version as a tag name.

Install and reload **both** the forked CLI and its matching Browser Bridge / Extension. Mismatched CLI/extension pairs will fail at runtime even if the plugin installs cleanly.

See your OpenCLI fork’s `FORK.md` for packaging details.

## Install

### Local (development)

Exact local install from the subplugin package path:

```bash
# from this repo root (adjust clone path if different)
REPO="$(pwd)"

opencli plugin uninstall chatgpt-agent 2>/dev/null || true
# Local installs use the standalone subplugin path (not the monorepo root).
opencli plugin install "${REPO}/packages/chatgpt-agent"

# verify
opencli plugin list
opencli chatgpt-agent ask --help
```

Re-install after plugin code changes when not using a live local path (see `opencli plugin list`).

### Hub / remote (GitHub)

Install the `chatgpt-agent` subplugin from this GitHub repo:

```bash
opencli plugin uninstall chatgpt-agent 2>/dev/null || true
opencli plugin install github:fengwk/my-opencli/chatgpt-agent

opencli plugin list
opencli chatgpt-agent ask --help
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

# prepare a Jimeng Agent video draft (default --submit 0); result includes auto assetId
opencli jimeng-agent video \
  --workspace <workspace-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0

# optional formal submit after checkpoint, then search/download by assetId
opencli jimeng-agent video ... --submit 1
opencli jimeng-agent status --workspace <workspace-id> --search_key <assetId> --download 1
```

### WSL + Windows Chrome

- Uploads under `/home/...` are **auto-staged** to `C:\Users\<user>\Downloads\opencli-upload\` so `setFileInput` can read them.
- Native Linux Chrome: no staging; paths used as-is.
- Override: `OPENCLI_UPLOAD_STAGE=0` disable / `=1` force.

## Develop / verify this repo

Root is a **private** workspace package (not published to npm). Node `>=20`.

```bash
npm ci
npm run check          # manifest + syntax validation, then unit tests
npm test               # vitest only
npm run validate       # opencli-plugin.json + package contracts + JS syntax
npm run validate:manifest
npm run validate:syntax
```

Release process (maintainers):

1. Keep plugin / root versions at the intended release (currently **`0.1.19`** for the next tag).
2. Push tag **`v<opencli-plugin.json version>`** exactly (e.g. `v0.1.19`). Do **not** move an existing published tag such as `v0.1.0`.
3. GitHub Actions `release.yml` runs the same checks, verifies the tag string, then creates a **GitHub Release with generated notes**.
4. No `npm publish` and no binary artifacts — consumers install from git/path only. Remote install still follows the default branch (see **Version pinning limitation** above); tags document known-good trees but are not install pins.

## Relation to OpenCLI fork

Core runtime changes (WS capture, setFileInput harden, `repeatable` args) live in the OpenCLI **fork**.

This repo only holds **adapter plugins** that should stay out of upstream `clis/` when possible.
