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
opencli jimeng-agent canvas-create --help
opencli jimeng-agent canvas-video --help
opencli jimeng-agent canvas-v0-create --help
opencli jimeng-agent canvas-v0-video --help
opencli jimeng-agent canvas-v0-status --help
opencli jimeng-agent canvas-v0-download --help
opencli jimeng-agent canvas-status --help
opencli jimeng-agent status --help
```

## Commands

| Command | Target | Surface |
|---|---|---|
| `video` | Generate page | `https://jimeng.jianying.com/ai-tool/generate?workspace=<workspace-id>` |
| `canvas-create` | AI Canvas | Create a blank canvas only, return its `project-id` for later runs |
| `canvas-video` | AI Canvas | `https://jimeng.jianying.com/ai-tool/ai-canvas` (`--canvas new` or `--canvas <project-id>`) |
| `canvas-v0-create` | Legacy canvas | Create a blank 初代画布 (`/ai-tool/canvas`) and return its numeric `project-id` |
| `canvas-v0-video` | Legacy canvas | `https://jimeng.jianying.com/ai-tool/canvas` (`--canvas new` or `--canvas <project-id>`) |
| `canvas-v0-status` | Legacy canvas | List legacy canvas generations with state, video definitions and asset ids |
| `canvas-v0-download` | Legacy canvas | Download one legacy canvas generation (md5 verified) |
| `canvas-status` | AI Canvas | List every current/historical resource, optionally correlated to one `asset-id` |
| `status` | History | Search and official download by `asset-id` |

## Canvas creation (`canvas-create`)

Creates a blank canvas project and returns nothing but its identity. No
reference is uploaded, no prompt is typed and nothing is submitted, so the
returned `project-id` can be reused by later `canvas-video` runs (one canvas
can host several clips):

```bash
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-create \
  --title '苏州猫咪短片 01' \
  -f json
```

```json
[
  {
    "status": "created",
    "project-id": "ac84c64a-420a-4077-afd6-aa239b68f0fb",
    "canvas-title": "苏州猫咪短片 01",
    "canvas-url": "https://jimeng.jianying.com/ai-tool/ai-canvas/ac84c64a-420a-4077-afd6-aa239b68f0fb"
  }
]
```

```bash
# prepare (and later submit) inside the canvas created above
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas ac84c64a-420a-4077-afd6-aa239b68f0fb \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 15 \
  --ratio 16:9 \
  --model-version seedance2.0fast \
  --submit 0
```

`--title` is optional and limited to 60 characters. Passing `--title` to
`canvas-video --canvas <project-id>` is rejected: existing canvases are never
renamed.

## Canvas Video Example (`canvas-video`)

Supports creating a new canvas (`--canvas new`) or continuing in an existing canvas (`--canvas <project-id>`):

```bash
# 1. Prepare in a new canvas (--canvas new, prepare-only default)
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas new \
  --title '人物镜头测试' \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0 \
  --submit 0

# 2. Formally submit in a new canvas (--submit 1)
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas new \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0 \
  --submit 1

# 3. Formally submit in an existing canvas by project id
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-video \
  --canvas c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84 \
  --prompt '镜头推近，展现细节。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0 \
  --submit 1
```

Canvas video flow:
1. Opens `/ai-tool/ai-canvas?enter_from=page_click&from_page=create` (`--canvas new`) or `/ai-tool/ai-canvas/<project-id>`.
2. When `--canvas new --title <name>` is supplied, waits for the real project id and persists the title through `/octo_api/v1/project/update`. Titles are limited to 60 characters; `--title` is rejected for existing canvases to prevent accidental renames.
3. Expands the right-hand AI conversation panel (文案「与 AI 对话」).
4. Clears leftover composer content.
5. Uploads references through the canvas composer's native attachment model and verifies visible ready chips.
6. Composes the prompt (including `资产编号：<asset-id>`) in one composer transaction: every text segment and every `@图片N` / `@视频N` / `@音频N` mention chip is written by a single `insertSegments` call, with chip descriptors copied from the uploaded attachment chips (same `attachmentId`, so historical same-name resources are never selected). Text and chips therefore cannot interleave. If the composer model is unavailable the run falls back to the visible `@` picker flow.
7. Performs content checkpoint (validates uploaded attachments, ordered rich-reference chips, and prompt anchors).
8. With `--submit 1`, waits for any active Canvas Agent turn (`canvas-agent-stop`) to finish, then clicks the unique enabled send control. Success requires either a correlated server ACK or the exact `asset-id` to move from the composer into the sent-message area; ambiguous states fail closed.
9. With `--submit 0`, leaves the verified draft visible and never clicks send.
10. Returns `project-id`, `canvas-title`, `canvas-url`, `asset-id`, `submitted`, `checkpoint-ok`.

`confirmation` is `ack_confirmed` when a correlated response is captured,
`ui_confirmed` when the exact sent-message transition is observed, and `none`
for prepare-only runs.

## Legacy canvas (`canvas-v0-create` / `canvas-v0-video` / `canvas-v0-status` / `canvas-v0-download`)

The 初代画布 surface (`/ai-tool/canvas/<project-id>`) is a different editor
from the current AI Canvas: projects are created through
`/mweb/v1/infinite_canvas/create_project` inside the authenticated page, the
title is limited to **20 characters**, and references are attached as files
instead of `@图片N` mention chips.

```bash
# 1. Create a blank legacy canvas and read its numeric project id
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-v0-create \
  --title '苏州猫咪 v0' \
  -f json

# 2. Prepare a draft (dry run: no generation is submitted)
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-v0-video \
  --canvas 22104771569420 \
  --image ./人物.png \
  --prompt '请以参考图中的角色为主角生成视频。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0fast \
  --submit 0

# 3. Submit for real only after the dry run looks right
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent canvas-v0-video \
  --canvas 22104771569420 \
  --image ./人物.png \
  --prompt '请以参考图中的角色为主角生成视频。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0fast \
  --submit 1
```

Legacy canvas flow:
1. `canvas-v0-create` posts an empty draft (`layers: []`) through the page's own
   `fetch` wrapper, so the signed `sign` / `x-secsdk-*` headers stay valid, then
   opens `<canvas-url>?enter_from=create_new&from_page=assets` and waits for the
   composer to mount. Nothing else is changed and nothing is submitted.
2. `canvas-v0-video` opens `--canvas new` (creating the project first) or an
   existing `/ai-tool/canvas/<project-id>` project and docks the right-hand
   「对话」 sidecar through its top-right button. A closed sidecar is still
   mounted (off-screen at `left == window.innerWidth`), so the panel is only
   accepted once ≥60% of it is inside the viewport; every later phase re-asserts
   that dock and the run fails closed instead of falling back to the canvas
   bottom composer. The launcher is clicked from inside the page (the toolbar
   re-renders between a marked selector and a CDP click) and the leased tab is
   brought to the front first (`foreground` window mode), because a hidden tab
   parks the panel's slide-in animation off-screen while the app already reports
   it open. Such a stalled panel is repaired by collapsing it through its own
   header control, or by one project reload, before the phase is allowed to fail.
3. Applies 创作类型 = Agent 模式. The docked panel renders that selector as an
   icon without a label, so the command opens its option list, reads the
   `aria-selected` option, closes the list again when it already matches, and
   re-reads it to confirm a switch.
4. Applies `--ratio` in the 「生成偏好」 panel: switches to video mode and selects
   the requested aspect ratio, then closes the popover. The panel also renders
   that trigger as an icon, so it is located by the icon it shares with the
   composer variant that still renders the 自动/自定义 label.
5. Clears leftover composer text **and leftover reference attachments** so
   repeated runs stay idempotent instead of stacking stale references.
6. Uploads every `--image` reference through the file input and waits for each
   reference card to finish.
7. Composes the prompt (including `资产编号：<asset-id>`) into the panel TipTap
   composer and verifies the visible text.
8. Content checkpoint: docked panel, expected reference count, prompt anchors in
   order, `资产编号：<asset-id>` present, no generation already running.
9. With `--submit 1`, arms a network capture on the legacy send path, then
   requires either a correlated ACK or the exact `资产编号：<asset-id>` marker
   moving out of the composer into the sent area. Any ambiguity fails closed.
10. With `--submit 0` (default), leaves the verified draft in place and never
    clicks send.
11. Returns `project-id`, `canvas-url`, `references`, `asset-id`, `submitted`,
    `checkpoint-ok`, `panel-open`, `confirmation`.

### Reading a legacy canvas back (`canvas-v0-status` / `canvas-v0-download`)

`canvas-status` cannot inspect legacy canvases: it reads the AI Canvas
`/octo_api/v1/project/draft/get` store and answers `project not found` for a
legacy `project-id`. Legacy canvases are read through their own endpoints
instead, all of them read-only:

| Call | Purpose |
|---|---|
| `POST /mweb/v1/infinite_canvas/project_detail` | Canvas draft: `aiGeneratorReference` maps every node to `{recordId, itemId, turnId}` |
| `POST /mweb/v1/get_history_by_ids` | History records: `status`, prompt, `fail_starling_message`, video definitions |

```bash
# Every generation of the canvas, newest first
OPENCLI_BROWSER_COMMAND_TIMEOUT=240 opencli jimeng-agent canvas-v0-status \
  --canvas 17883546906892 \
  --limit 5 \
  -f json

# One run of canvas-v0-video, correlated by its asset-id
OPENCLI_BROWSER_COMMAND_TIMEOUT=240 opencli jimeng-agent canvas-v0-status \
  --canvas 17883546906892 \
  --asset-id 58674724fb245869

# Download one generation (the md5 published by the API is verified)
OPENCLI_BROWSER_COMMAND_TIMEOUT=240 opencli jimeng-agent canvas-v0-download \
  --canvas 17883546906892 \
  --record-id 39441026984460 \
  --definition 720p \
  --output ~/Downloads/jimeng-agent
```

`canvas-v0-status` rows carry the generation state plus every fact it was derived
from, so nothing has to be guessed:

- `status` is `ready` (a downloadable video exists), `failed`
  (`fail_starling_message` / `fail_starling_key` is set) or `pending` (no video
  yet: never submitted, still running, or a non-video task).
- `status-code` / `status-name` / `item-status-code` are the raw API codes;
  only the codes observed live are named (`50` → `finished`).
- `no-generations` is reported as an explicit row for a canvas whose
  `aiGeneratorReference` is still empty, and `no-matching-generation` when a
  filter matched nothing.
- `asset-id` comes from `资产编号：…` inside the stored prompt, so a legacy
  generation is reachable exactly like a `canvas-video` one.

Asset-id correlation reads the prompt stored on the history record, which is
what a finished generation always carries. Whether a still-running record
already comes back with that prompt was never observed (no run has been left
in flight), so right after `--submit 1` prefer listing the canvas without a
filter, or query the `record-id` from that listing.

`canvas-v0-download` picks the newest ready generation unless `--record-id` or
`--asset-id` narrows it, falls back to the best published definition (reporting
`definition-fallback`) when the requested one is missing, verifies the md5 of
the bytes it received, and writes nothing when the checksum does not match.

Differences from `canvas-video` worth knowing:

- Videos are downloaded from the signed CDN definitions returned by
  `get_history_by_ids` (`origin` / `720p` / `480p` / `360p`), so they need a
  fresh `canvas-v0-download` run once a URL has expired.
- References are uploaded as files; `--prompt` must be plain text without
  `@图片N`-style mentions (the legacy composer has no rich-reference picker).
- Titles are capped at 20 characters and, as with `canvas-video`, `--title` is
  rejected unless `--canvas new` is used.
- The legacy canvas shares one composer model between the bottom composer and
  the 「对话」 sidecar, so text typed in either place is what gets submitted.
- Docking the 「对话」 panel is the one step that depends on the leased tab being
  foreground: run `canvas-v0-video` against a tab the browser renders, and if the
  panel is ever reported open while sitting off-screen, the command recovers it
  itself (collapse, then reload) instead of typing into the bottom composer.

## Canvas resource status (`canvas-status`)

List all resources currently referenced by an existing canvas, including
generating, completed, failed, canceled, and deleted generations:

```bash
opencli jimeng-agent canvas-status \
  --canvas <project-id> \
  -f json
```

Filter to the resources created from one exact `canvas-video` submission:

```bash
opencli jimeng-agent canvas-status \
  --canvas <project-id> \
  --asset-id 9ef879de0504e787 \
  -f json
```

The command is read-only. It combines four Canvas-owned data sources:

```text
project/draft/get
  -> every node.data.resourceId and resourceBatches[].resourceIds

canvas_agent/sessions/list -> canvas_agent/events/list
  -> 资产编号:<asset-id> on TURN_STARTED / INPUT_ACCEPTED
  -> same turn_id TOOL_CALL_FINISHED(run_nodes)
  -> render_infos[].artifacts[].resource_id

resource/batch_get
  -> live status, generation metadata, and signed media URLs
```

This same-turn artifact join is the authoritative `asset-id` correlation; input
reference `resource_id` values are not treated as generated outputs. Numeric
resource states are normalized as `200=generating`, `1000=ready`,
`1001=failed`, `1002=canceled`, and `2000=deleted`. If an exact submitted turn
exists but has not emitted an artifact yet, the result is `pending`. Pagination
fails closed when `--max-pages` is exhausted, so a partial scan is never
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
  --model-version seedance2.0 \
  --submit 0

# Formal submit after the same checkpoint passes
OPENCLI_BROWSER_COMMAND_TIMEOUT=300 opencli jimeng-agent video \
  --workspace <workspace-id> \
  --image ./人物.png \
  --video ./动作.mp4 \
  --prompt '请以@图片1作为人物形象，参考@视频1的运镜。' \
  --duration 5 \
  --ratio 16:9 \
  --model-version seedance2.0 \
  --submit 1
# Result includes auto-generated `asset-id` (16-char hex). Use it with status --search-key.
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

Each `video` run auto-generates a 16-char hex `asset-id`, embeds `资产编号：<id>` into
the agent prompt, and returns it in the CLI result for later `status --search-key`.

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
  - HTTP 2xx status matching canonical `asset-id`
  - Valid SSE `handshake` with non-empty `thread_id` and conversation consistency
  - Valid SSE `stream_complete` with `success=true` and `error_code=0`
- The post-click capture buffer is preserved for the full ACK window and read
  once, so an observed request cannot disappear and be downgraded to `not-sent`.
- A fresh retry is allowed only when no conversation request was captured and
  the `asset-id` still exists solely in the composer. Before that retry clicks,
  any delayed matching request/ACK from the prior attempt is consumed and
  causes confirmation or a fail-closed stop instead of a second paid click.
- If a submit request is seen but the response is missing, truncated, or unconfirmed,
  or if the server explicitly rejects the request, the command stops immediately and
  prohibits automatic retries to prevent duplicate charges or infinite loops.
- Output columns include `status`, `workspace`, `workspace-url`, `uploaded`, `mentions`,
  `asset-id`, `retry-used`, `submitted`, `checkpoint-ok`, `confirmation`, `thread-id`,
  `conversation-id`, and `submit-request-count`.
- Successful prepare results include `checkpoint-ok: true`, `submitted: false`, and `confirmation: 'none'`.
- Confirmed submit results include `checkpoint-ok: true`, `submitted: true`, `confirmation: 'ack_confirmed'`, `thread-id`, and `conversation-id`.

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
  --search-key b7e4f19a2c0d5e68 \
  --download 0

# Search + download newest ready video
opencli jimeng-agent status \
  --workspace <workspace-id> \
  --search-key b7e4f19a2c0d5e68 \
  --download 1 \
  --output ~/Downloads/jimeng-agent
```

Returned fields include `status` (`ready` / `generating` / `cancelled` / `not_found` / `failed` / `unknown`), `data-id`, `task-type`, `path`, `collected`, `collected-from`, `download-bytes`, `download-note`, `download-error`, and `download-warning`.

Download strategy (`--download 1`) mirrors `chatgpt-agent` file collection:

1. Prefer the official card **下载** button via `waitForDownload` (full quality; typically ~9MB+)
2. Remap Windows Chrome paths (`C:\...` → `/mnt/c/...` on WSL)
3. Copy into managed `--output` and rewrite `path` (`collected=true`, `collected-from=<chrome path>`)
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
