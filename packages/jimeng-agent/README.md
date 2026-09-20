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
opencli jimeng-agent canvas-video --help
opencli jimeng-agent canvas-status --help
opencli jimeng-agent status --help
```

## Commands

| Command | Target | Surface |
|---|---|---|
| `video` | Generate page | `https://jimeng.jianying.com/ai-tool/generate?workspace=<workspace-id>` |
| `canvas-video` | AI Canvas | `https://jimeng.jianying.com/ai-tool/ai-canvas` (`--canvas new` or `--canvas <projectId>`) |
| `canvas-status` | AI Canvas | List every current/historical resource, optionally correlated to one `assetId` |
| `status` | History | Search and official download by assetId |

## Canvas Video Example (`canvas-video`)

Supports creating a new canvas (`--canvas new`) or continuing in an existing canvas (`--canvas <projectId>`):

```bash
# 1. Prepare in a new canvas (--canvas new, prepare-only default)
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas new \
  --title '人物镜头测试' \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 0

# 2. Formally submit in a new canvas (--submit 1)
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas new \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 1

# 3. Formally submit in an existing canvas by project id
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84 \
  --prompt '镜头推近，展现细节。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0 \
  --submit 1
```

Canvas video flow:
1. Opens `/ai-tool/ai-canvas?enter_from=page_click&from_page=create` (`--canvas new`) or `/ai-tool/ai-canvas/<projectId>`.
2. When `--canvas new --title <name>` is supplied, waits for the real project id and persists the title through `/octo_api/v1/project/update`. Titles are limited to 60 characters; `--title` is rejected for existing canvases to prevent accidental renames.
3. Expands the right-hand AI conversation panel (文案「与 AI 对话」).
4. Clears leftover composer content.
5. Uploads references through the canvas composer's native attachment model and verifies visible ready chips.
6. Types prompt directives, including `资产编号：<assetId>`, and replaces each `@图片N` / `@视频N` / `@音频N` placeholder through the visible `@` picker. Candidate selection is bound to the current upload's exact `attachmentId`, so historical same-name resources are never selected ambiguously.
7. Performs content checkpoint (validates uploaded attachments, ordered rich-reference chips, and prompt anchors).
8. With `--submit 1`, waits for any active Canvas Agent turn (`canvas-agent-stop`) to finish, then clicks the unique enabled send control. Success requires either a correlated server ACK or the exact `assetId` to move from the composer into the sent-message area; ambiguous states fail closed.
9. With `--submit 0`, leaves the verified draft visible and never clicks send.
10. Returns `projectId`, `canvasTitle`, `canvasUrl`, `assetId`, `submitted`, `checkpointOk`.

`confirmation` is `ack_confirmed` when a correlated response is captured,
`ui_confirmed` when the exact sent-message transition is observed, and `none`
for prepare-only runs.

## Canvas resource status (`canvas-status`)

List all resources currently referenced by an existing canvas, including
generating, completed, failed, canceled, and deleted generations:

```bash
opencli jimeng-agent canvas-status \
  --canvas <projectId> \
  -f json
```

Filter to the resources created from one exact `canvas-video` submission:

```bash
opencli jimeng-agent canvas-status \
  --canvas <projectId> \
  --asset_id 9ef879de0504e787 \
  -f json
```

The command is read-only. It combines four Canvas-owned data sources:

```text
project/draft/get
  -> every node.data.resourceId and resourceBatches[].resourceIds

canvas_agent/sessions/list -> canvas_agent/events/list
  -> 资产编号:<assetId> on TURN_STARTED / INPUT_ACCEPTED
  -> same turn_id TOOL_CALL_FINISHED(run_nodes)
  -> render_infos[].artifacts[].resource_id

resource/batch_get
  -> live status, generation metadata, and signed media URLs
```

This same-turn artifact join is the authoritative `assetId` correlation; input
reference `resource_id` values are not treated as generated outputs. Numeric
resource states are normalized as `200=generating`, `1000=ready`,
`1001=failed`, `1002=canceled`, and `2000=deleted`. If an exact submitted turn
exists but has not emitted an artifact yet, the result is `pending`. Pagination
fails closed when `--max_pages` is exhausted, so a partial scan is never
reported as a complete list.

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

## Reference upload contract

Jimeng changed how the composer accepts references. The adapter supports both
generations and picks whichever the live page exposes:

| Generation | Upload entry | How the adapter fills it |
|---|---|---|
| Current | Composer `+` tile (`reference-upload-*`); the site opens a chooser on click | The adapter removes `window.showOpenFilePicker` so the site takes its own `<input type="file">` fallback, silences the native picker on that input, clicks the tile, then assigns the file with CDP `DOM.setFileInputFiles` |
| Legacy | Hidden `input[type="file"]` always present in the dock | The adapter marks the resident input and assigns the file directly |

Only the site's own fallback input is used — nothing is uploaded outside the
visible UI, and no file chooser is intercepted at the browser-protocol level.
The reference card remove control is likewise resolved through both contracts
(`[data-reference-remove-button="true"]` or `.remove-button-*`).

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

Search history by asset id or prompt snippet, optionally download the newest ready video.

The history search box now lives in the page header (portaled out of the
record-list container). The adapter still binds that unique visible input to
the unique visible `[data-record-list-container]` / `record-list-container`
feed, including the legacy nested layout.

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
