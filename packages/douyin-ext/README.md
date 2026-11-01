# opencli-plugin-douyin-ext

Douyin video downloader plugin for OpenCLI.

Requires the forked OpenCLI CLI `>=2.0.2-fengwk.1`; use CLI
`2.0.2-fengwk.2` with Browser Bridge `1.0.37` for the current Hub release.
Only download videos you own or are authorized to save.

## Strategy Note

- **Strategy**: `PAGE_FETCH`, `internal-unstable`
- **Rationale**: Douyin's `/aweme/v1/web/aweme/detail/` is not a stable public API. Direct Node HTTP requests lack the browser session, runtime environment, and dynamic signatures (`a_bogus`, `msToken`), leading to immediate risk controls. Conversely, scraping through the DOM or relying on third-party extension UIs ("抖音超级助手") fails to yield reliably verifiable files, and background `chrome.downloads` may lack page-context lifecycle events.
- **Implementation**: The plugin navigates the background browser to the official video page, performs a strictly read-only, non-mutating in-page `fetch(credentials: 'include')` to obtain structured video metadata, and streams the binary MP4 stream directly over Node HTTP to the local execution host (e.g. Hub server).
- **Disclaimer**: This relies on internal Douyin endpoints. It **does not claim or guarantee unauthenticated success**; deleted, private, geo-blocked, or rate-limited content will return typed errors and prompt the user to inspect page state or log in.

## Features

- **No Third-Party Chrome Extension**: Operates independently without requiring "抖音超级助手" or calling its services.
- **Target Resolution**: Supports 16–20 digit numeric video IDs, full official HTTPS Douyin video URLs (`/video/<id>`, `/share/video/<id>`, `modal_id`), and `v.douyin.com` short share links with redirect loop detection and hop bounds.
- **SSRF & Security**: Strict HTTPS, standard port, and domain validation. CDN allowlist strictly restricted to `*.douyinvod.com` and `www.douyin.com/aweme/v1/play/`. Query signatures and path tokens are stripped from output; `source` reports verified CDN hostname only.
- **Format Filtering**: Rejects DASH and audio-only streams; selects verified merged MP4 variants.
- **Quality Selection**: Supports `best`, `2160p`, `1440p`, `1080p`, `720p`, `540p`, `480p`, `360p`. If a requested quality is not present, throws an explicit error rather than silently degrading.
- **Reliable Local Download**: Streams via `pipeline` with chunk-accumulated MP4 `ftyp` box verification (rejecting HTML error pages). Employs atomic `link + unlink` hardlink loop to guarantee existing files are never overwritten even under concurrency.

## Usage

```bash
# Download highest quality video to the current directory
opencli douyin-ext download "https://v.douyin.com/xxxx/"

# Specify target output directory and quality
opencli douyin-ext download 7701962254330128228 --output ./downloads --quality 1080p

# Set custom overall timeout in seconds
opencli douyin-ext download "https://www.douyin.com/video/7701962254330128228" --timeout 120
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `<target>` | String (positional) | *required* | Numeric ID, official video URL, or `v.douyin.com` share link |
| `--output` | String | `.` | Target directory on CLI execution host |
| `--quality` | String | `best` | `best`, `2160p`, `1440p`, `1080p`, `720p`, `540p`, `480p`, `360p` |
| `--timeout` | Integer | `60` | Overall timeout in seconds shared across target resolution, API fetch, and stream download |

## Output Fields

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

`quality` is the platform's rendition label, not a guarantee of exact pixel dimensions.
For example, the verified `540p` rendition was 1024×576. An end-to-end check saved
7,866,605 bytes for video `7701287709930835226`; `ffprobe` confirmed H.264 video,
AAC audio, and 74.91 seconds of duration. This check used the local browser's
existing login state, not a deployed Hub instance.
