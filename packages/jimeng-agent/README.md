# jimeng-agent (OpenCLI plugin)

Jimeng Agent workflow for video prompts with local references.

The `video` command:

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
opencli jimeng-agent video --help
opencli jimeng-agent status --help
```

## Example

```bash
# Prepare only (default): green checkpoint required, no generation cost
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent video \
  --workspace <workspace-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 0

# Formal submit after the same checkpoint passes
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent video \
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

Each `video` run auto-generates a 16-char hex `assetId`, embeds `资产编号：<id>` into
the agent prompt, and returns it in the CLI result for later `status --search_key`.

## Two-phase gates

### Pre-input controls (before upload / typing)

- Surface ready
- Agent mode selected
- Auto preference enabled (read from the dock 自动 button when the panel is closed)
- Video preference selected

Failure phase: `pre-input`. The Auto preference panel is **not** force-opened to
re-read state (that was flaky on Hub); the dock's 自动 button is the source of
truth once configured.

### Content checkpoint (after prompt is filled)

- Reference card count matches uploaded assets (dock reference strip only;
  empty upload slots kept from a restored draft are excluded). Current Jimeng
  may collapse a long strip to a first/last "more" entry; the checkpoint
  treats that visible proxy as valid only when all expected rich mentions are
  committed.
- Rich mention count/order matches the prompt
- No raw `@` leftovers and no open mention menu
- Prompt line structure matches the assembled agent prompt
- Generate control armed only when `--submit 1`

Failure phase: `checkpoint`. This gate does **not** reopen or re-check the Auto panel.

## Safety boundary & Submit ACK

- Mention selection revalidates and clicks the unique marked resource candidate
  in one browser-side operation; it does not dispatch bare Enter.
- Default `--submit 0` never starts generation.
- `--submit 1` is the only path that clicks the generate control, and only after
  a green checkpoint.
- Formal submit requires active network capture of `POST /mweb/v1/creation_agent/v2/conversation`.
  If network capture is unavailable, submit fails before clicking generate.
- Successful submission requires explicit server ACK:
  - HTTP 2xx status matching canonical `assetId`
  - Valid SSE `handshake` with non-empty `thread_id` and conversation consistency
  - Valid SSE `stream_complete` with `success=true` and `error_code=0`
- The post-click capture buffer is preserved for the full ACK window and read
  once, so an observed request cannot disappear and be downgraded to `not-sent`.
- A fresh retry is allowed only when no conversation request was captured and
  the `assetId` still exists solely in the composer. Before that retry clicks,
  any delayed matching request/ACK from the prior attempt is consumed and
  causes confirmation or a fail-closed stop instead of a second paid click.
- If a submit request is seen but the response is missing, truncated, or unconfirmed,
  or if the server explicitly rejects the request, the command stops immediately and
  prohibits automatic retries to prevent duplicate charges or infinite loops.
- Output columns include `status`, `workspace`, `workspaceUrl`, `uploaded`, `mentions`,
  `assetId`, `retryUsed`, `submitted`, `checkpointOk`, `confirmation`, `threadId`,
  `conversationId`, and `submitRequestCount`.
- Successful prepare results include `checkpointOk: true`, `submitted: false`, and `confirmation: 'none'`.
- Confirmed submit results include `checkpointOk: true`, `submitted: true`, `confirmation: 'ack_confirmed'`, `threadId`, and `conversationId`.

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
4. Fall back only to a search-API media URL whose business/asset identity
   uniquely matches the selected DOM row; otherwise fail closed

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
