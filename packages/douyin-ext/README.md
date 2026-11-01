# opencli-plugin-douyin-ext

Douyin video downloader plugin for OpenCLI.

## Strategy Note

- **Strategy**: `PAGE_FETCH`, `internal-unstable`
- **Rationale**: Douyin's `/aweme/v1/web/aweme/detail/` is not a stable public API. Direct Node HTTP requests lack the browser session, runtime environment, and dynamic signatures (`a_bogus`, `msToken`), leading to immediate risk controls. Conversely, scraping through the DOM or relying on third-party extension UIs ("抖音超级助手") fails to yield reliably verifiable files, and background `chrome.downloads` may lack page-context lifecycle events.
- **Implementation**: The plugin navigates the background browser to the official video page, performs a strictly read-only, non-mutating in-page `fetch(credentials: 'include')` to obtain structured video metadata, and streams the binary MP4 stream directly over Node HTTP to the local execution host (e.g. Hub server).
- **Disclaimer**: This relies on internal Douyin endpoints. It **does not claim or guarantee unauthenticated success**; deleted, private, geo-blocked, or rate-limited content will return typed errors and prompt the user to inspect page state or log in.

## Features

- **No Third-Party Chrome Extension**: Operates independently without requiring "抖音超级助手" or calling its services.
- **Target Resolution**: Supports 16–20 digit numeric video IDs, full official HTTPS Douyin video URLs (`/video/<id>`, `/share/video/<id>`, `modal_id`), and `v.douyin.com` short share links with redirect loop detection and hop bounds.
- **SSRF & Security**: Strict HTTPS, standard port, and domain validation on all input and redirect hops. URL tokens and signatures are stripped from logs and structured output.
- **Format Filtering**: Rejects DASH and audio-only streams; selects verified merged MP4 variants.
- **Quality Selection**: Chooses between `best`, `1080p`, `720p`, `540p`, `480p`, `360p`. If a requested quality is not present, throws an explicit error rather than silently degrading.
- **Reliable Local Download**: Streams directly to a unique temporary file, checks MIME, MP4 magic header, and Content-Length. Automatically handles name collision to avoid overwriting existing files.

## Usage

```bash
# Download highest quality video to the current directory
opencli douyin-ext download "https://v.douyin.com/xxxx/"

# Specify target output directory and quality
opencli douyin-ext download 7701962254330128228 --output ./downloads --quality 1080p

# Set custom timeout in seconds
opencli douyin-ext download "https://www.douyin.com/video/7701962254330128228" --timeout 120
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `<target>` | String (positional) | *required* | Numeric ID, official video URL, or `v.douyin.com` share link |
| `--output` | String | `.` | Target directory on CLI execution host |
| `--quality` | String | `best` | `best`, `1080p`, `720p`, `540p`, `480p`, `360p` |
| `--timeout` | Integer | `60` | Overall timeout in seconds for API fetch and stream download |
