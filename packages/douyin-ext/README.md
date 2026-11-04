# opencli-plugin-douyin-ext

Douyin video downloader and user pagination plugin for OpenCLI.

Requires the forked OpenCLI CLI `>=2.0.2-fengwk.1`; use CLI
`2.0.2-fengwk.2` with Browser Bridge `1.0.37` for the current Hub release.
Only download videos you own or are authorized to save.

## Strategy Note

- **Strategy**: `PAGE_FETCH`, `internal-unstable`
- **Rationale**: Douyin's `/aweme/v1/web/aweme/detail/` and `/aweme/v1/web/aweme/post/` are internal Douyin Web endpoints. Direct Node HTTP requests lack the browser session, cookies, and dynamic runtime signatures (`a_bogus`, `msToken`), leading to immediate risk controls or rejection. Conversely, scraping through DOM scrolling cannot reliably deliver stable resume cursors (`max_cursor`) and is fragile against frontend layout mutations; third-party extensions ("抖音超级助手") introduce extraneous dependencies and unverifiable execution flows.
- **Why PAGE_FETCH**: Inherits the active, authenticated browser JavaScript runtime environment, cookies, and dynamic cryptographic signing mechanisms transparently without attempting to reverse-engineer signatures or bypass CAPTCHAs.
- **Implementation**:
  - `download`: The plugin navigates the background browser to the official video page, performs a strictly read-only, non-mutating in-page `fetch(credentials: 'include')` to obtain structured video metadata, and streams the binary MP4 stream directly over Node HTTP to the local execution host (e.g. Hub server).
  - `user-videos`: The plugin navigates to the official user homepage (`/user/<sec_uid>`), executes an in-page read-only `fetch` against `/aweme/v1/web/aweme/post/?aid=6383&sec_user_id=...&max_cursor=...&count=...` with `credentials: 'include'`, preserves complete pages without dropping rows or slicing, and provides verified pagination state (`cursor`, `next_cursor`, `has_more`, `items`). When `--comment-limit > 0`, it sequentially fetches top comments via `/aweme/v1/web/comment/list/` under the same overall timeout budget.
- **Verified Live Evidence**:
  - Environment: A signed-in remote browser; target public profile 李一帆 (`sec_uid=MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU`). This is the profile being read, not the identity of the signed-in account.
  - First page GET request (`max_cursor=0`, `count=20`): Returned HTTP 200, `status_code: 0`, 18 videos, `has_more: 1`, `max_cursor: 1789453816000`.
  - Second page GET request (`max_cursor=1789453816000`, `count=20`): Returned HTTP 200, `status_code: 0`, 15 distinct videos, `has_more: 1`, `max_cursor: 1784127963000`.
  - Real API payload verified fields: `status_code`, `min_cursor`, `max_cursor`, `has_more`, `aweme_list`.
- **Disclaimer**: This relies on internal Douyin endpoints. It **does not claim or guarantee unauthenticated success**; deleted, private, geo-blocked, or rate-limited content will return typed errors and prompt the user to inspect page state or log in.

## Features

- **No Third-Party Chrome Extension**: Operates independently without requiring "抖音超级助手" or calling its services.
- **Target Resolution**: Supports 16–20 digit numeric video IDs, full official HTTPS Douyin video URLs (`/video/<id>`, `/share/video/<id>`, `modal_id`), and `v.douyin.com` short share links with redirect loop detection and hop bounds.
- **User Video Cursor Pagination**: Single-page cursor pagination primitive `douyin-ext user-videos` delivering exact string cursors, boolean `has_more`, safe 16-20 digit IDs, image collection detection (`is_image`), and optional top comments.
- **SSRF & Security**: Strict HTTPS, standard port, and domain validation. CDN allowlist strictly restricted to `*.douyinvod.com` and `www.douyin.com/aweme/v1/play/`. Query signatures and path tokens are stripped from output; `source` reports verified CDN hostname only.
- **Format Filtering**: Rejects DASH and audio-only streams; selects verified merged MP4 variants.
- **Quality Selection**: Supports `best`, `2160p`, `1440p`, `1080p`, `720p`, `540p`, `480p`, `360p`. If a requested quality is not present, throws an explicit error rather than silently degrading.
- **Reliable Local Download**: Streams via `pipeline` with chunk-accumulated MP4 `ftyp` box verification (rejecting HTML error pages). Employs atomic `link + unlink` hardlink loop to guarantee existing files are never overwritten even under concurrency.
- **UTF-8 Filenames**: Final filenames stay within 255 UTF-8 bytes, including the complete video ID, extension, and any collision counter. Titles are shortened at Unicode code-point boundaries without changing the returned title metadata.

## Usage

### 1. Download Video (`douyin-ext download`)

```bash
# Download highest quality video to the current directory
opencli douyin-ext download "https://v.douyin.com/xxxx/"

# Specify target output directory and quality
opencli douyin-ext download 7701962254330128228 --op ./downloads --quality 1080p

# Set custom overall timeout in seconds
opencli douyin-ext download "https://www.douyin.com/video/7701962254330128228" --timeout 120
```

### 2. User Videos Pagination (`douyin-ext user-videos`)

```bash
# Fetch the first page of videos for a user (default cursor 0, count 20)
opencli douyin-ext user-videos "https://www.douyin.com/user/MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU"

# Fetch next page using returned next_cursor with comments enabled
opencli douyin-ext user-videos MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU --cursor 1789453816000 --count 20 --comment-limit 5 --timeout 60
```

## Options

### Options: `download`

| Option | Type | Default | Description |
|---|---|---|---|
| `<target>` | String (positional) | *required* | Numeric ID, official video URL, or `v.douyin.com` share link |
| `--op` | String | `.` | Target directory on CLI execution host for downloaded video |
| `--quality` | String | `best` | `best`, `2160p`, `1440p`, `1080p`, `720p`, `540p`, `480p`, `360p` |
| `--timeout` | Integer | `60` | Overall timeout in seconds shared across target resolution, API fetch, and stream download |

### Options: `user-videos`

| Option | Type | Default | Description |
|---|---|---|---|
| `<target>` | String (positional) | *required* | Douyin user `sec_uid` or official user URL (`https://www.douyin.com/user/<sec_uid>`) |
| `--cursor` | String | `0` | Pagination cursor string (digits-only string, never rounded or truncated) |
| `--count` | Integer | `20` | Number of videos to fetch per page (1..20) |
| `--comment-limit` | Integer | `0` | Maximum top comments per video (0..10, default 0 disables comment fetching) |
| `--timeout` | Integer | `60` | Overall timeout in seconds covering navigation, wait, post fetch, and comment fetch (1..600) |

## Output Fields

### Output Fields: `download`

| Column | Description |
|---|---|
| `status` | Execution status (`ok`) |
| `id` | Douyin aweme numeric ID |
| `title` | Cleaned video title or description |
| `author` | Creator nickname |
| `quality` | Resolved quality tag (e.g. `1080p`, `720p`) |
| `codec` | Video codec (`h264`, `h265`, or `unknown`) |
| `path` | Absolute filesystem path on CLI execution host |
| `bytes` | Total downloaded file size in bytes |
| `source` | Verified CDN hostname (e.g. `v26-web.douyinvod.com`) without signatures or path tokens |

### Output Fields: `user-videos`

Returns a single row object with columns `['sec_uid', 'cursor', 'next_cursor', 'has_more', 'items']`:

| Column | Description |
|---|---|
| `sec_uid` | Normalized user security identifier (`MS4wLjABAAAA...`) |
| `cursor` | Input cursor string for this page request |
| `next_cursor` | Next page cursor string derived from API `max_cursor` |
| `has_more` | Boolean indicating whether more videos are available |
| `items` | Array of video item objects in this page |

Each object in `items` is a flat metadata record. Optional metadata is `null` when
the API omits it or returns an invalid type; one bad optional field never drops the
item or fails the page. Metadata extraction adds no extra API request. Only
`aweme_id` and the pagination fields (`cursor`, `next_cursor`, `has_more`) are strict.

Each object in `items` contains:
- `aweme_id`: Verified 16-20 digit numeric ID string
- `title`: Trimmed display title derived from the description (or title)
- `item_title`: Douyin short title exactly as returned, or `null`; an empty short title stays `""`
- `desc`: Raw description exactly as returned, or `null`
- `desc_has_truncation_notice`: `true` only when `desc` ends with the known `……版本过低，升级后可展示全部信息` notice, otherwise `false`
- `duration`: Video duration in seconds, rounded from `duration_ms`, or `null` if missing/invalid
- `duration_ms`: Raw video duration in milliseconds, or `null`
- `create_time`: Raw creation timestamp in seconds, or `null`
- `author`: Object `{ nickname, uid, sec_uid, unique_id }`, or `null`. `uid` is preserved as a string; unsafe numeric IDs are not coerced. Individual fields are `null` when missing/invalid, and `unique_id` may legitimately be `null`.
- `width`: Video width in pixels, or `null`
- `height`: Video height in pixels, or `null`
- `cover_url`: Video cover image URL, or `null`
- `music`: Object `{ title, author }`, or `null`
- `digg_count`: Like count as a non-negative safe integer, or `null`
- `comment_count`: Comment count as a non-negative safe integer, or `null`
- `collect_count`: Favorite/collection count as a non-negative safe integer, or `null`
- `share_count`: Share count as a non-negative safe integer, or `null`
- `play_url`: Platform playback URL, which may redirect; use `download` to select and validate a merged MP4 stream. It is `""` when unavailable.
- `top_comments`: Array of top comments (`[{ text, digg_count, nickname }]`), empty if `--comment-limit 0`
- `url`: Official video URL (`https://www.douyin.com/video/<aweme_id>`)
- `is_image`: Boolean indicating whether this post is an image gallery (图集)

Counts are never padded: a missing or invalid count is `null`, while a real `0` stays
`0`. The post endpoint's `play_count` is not exported because the observed payload
returned `0` for every item and no trustworthy playback count was available.

`quality` in `download` is the platform's rendition label, not a guarantee of exact pixel dimensions.
For example, the verified `540p` rendition was 1024×576. An end-to-end check saved
7,866,605 bytes for video `7701287709930835226`; `ffprobe` confirmed H.264 video,
AAC audio, and 74.91 seconds of duration. This check used the local browser's
existing login state, not a deployed Hub instance.
