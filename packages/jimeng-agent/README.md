# jimeng-agent (OpenCLI plugin)

Jimeng Agent workflow for video prompts with local references.

The `ask` command:

1. Clears leftover composer text and reference cards.
2. Selects Agent mode.
3. Opens the generation-preference panel by DOM structure.
4. Enables Auto and selects the video radio when necessary.
5. **Pre-input controls check** (Agent / Auto / Video) — before any upload/prompt.
6. Uploads image / video / audio references one-by-one and confirms each card.
7. Replaces `@图片N`, `@视频N`, and `@音频N` with Jimeng rich mentions.
8. **Content checkpoint** (references + prompt only) — does not reopen Auto panel.
9. Optionally submits generation with `--submit 1` only after the content checkpoint is green.

## Install

```bash
opencli plugin install /path/to/my-opencli/packages/jimeng-agent
opencli jimeng-agent ask --help
opencli jimeng-agent status --help
```

## Example

```bash
# Prepare only (default): green checkpoint required, no generation cost
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent ask \
  --workspace <workspace-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 0

# Formal submit after the same checkpoint passes
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent ask \
  --workspace <workspace-id> \
  --image ./人物.png \
  --video ./动作.mp4 \
  --prompt '请以@图片1作为人物形象，参考@视频1的运镜。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 1
# Result includes auto-generated assetId (16-char hex). Use it with status --search_key.
```

Reference flags are repeatable. Labels are assigned independently by media kind
and upload order: `图片1`, `图片2`, `视频1`, `音频1`, and so on.

Each `ask` run auto-generates a 16-char hex `assetId`, embeds `资产编号：<id>` into
the agent prompt, and returns it in the CLI result for later `status --search_key`.

## Two-phase gates

### Pre-input controls (before upload / typing)

- Surface ready
- Agent mode selected
- Auto preference enabled
- Video preference selected
- Preference panel is readable at check time

Failure phase: `pre-input`.

### Content checkpoint (after prompt is filled)

- Reference card count matches uploaded assets
- Rich mention count/order matches the prompt
- No raw `@` leftovers and no open mention menu
- Prompt line structure matches the assembled agent prompt
- Generate control armed only when `--submit 1`

Failure phase: `checkpoint`. This gate does **not** reopen or re-check the Auto panel.

## Safety boundary

- Mention selection uses Enter only after a synchronous capture-phase guard
  confirms the unique candidate, active suggestion, editor focus, and collapsed
  selection are still valid.
- Default `--submit 0` never starts generation.
- `--submit 1` is the only path that clicks the generate control, and only after
  a green checkpoint.
- Successful prepare results include `checkpointOk: true` and `submitted: false`.

## Status / download

Search history by asset id or prompt snippet, optionally download the newest ready video:

```bash
# Search only
opencli jimeng-agent status \
  --workspace <workspace-id> \
  --search_key b7e4f19a2c0d5e68 \
  --download 0

# Search + download newest ready video
opencli jimeng-agent status \
  --workspace <workspace-id> \
  --search_key b7e4f19a2c0d5e68 \
  --download 1 \
  --output ~/Downloads/jimeng-agent
```

Returned fields include `status` (`ready` / `generating` / `cancelled` / `not_found`), `dataId`, `taskType`, `path`, `collected`, `collectedFrom`, `downloadBytes`, `downloadNote`.

Download strategy (`--download 1`) mirrors `chatgpt-agent` file collection:

1. Prefer the official card **下载** button via `waitForDownload` (full quality; typically ~9MB+)
2. Remap Windows Chrome paths (`C:\...` → `/mnt/c/...` on WSL)
3. Copy into managed `--output` and rewrite `path` (`collected=true`, `collectedFrom=<chrome path>`)
4. Fall back to search-API media URL, then preview `<video src>` only if official download fails

## Media preflight

- Video/audio each: `2s <= duration <= 15s`
- At most 3 videos and 3 audios
- Combined video duration and combined audio duration each `<= 15s`
- Combined references `<= 12`

## WSL + Windows Chrome

Windows Chrome cannot upload WSL paths directly. The plugin creates a disposable
Windows-visible alias directory and copies each reference using its Jimeng label
as the filename, such as `图片1.png`.

Optional environment variables:

- `OPENCLI_JIMENG_UPLOAD_ALIAS_ROOT`: override the disposable alias root.
- `OPENCLI_UPLOAD_STAGE=0|1`: disable or force Windows upload staging.
- `OPENCLI_JIMENG_MENTION_DEBUG=1`: capture mention screenshots and DOM state.
- `OPENCLI_BROWSER_COMMAND_TIMEOUT`: raise for multi-reference runs (e.g. 300).
