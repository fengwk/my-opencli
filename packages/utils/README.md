# utils scrape (OpenCLI plugin)

Fetch any `http(s)` URL in the **host Chrome** and export clean markdown, links, or a screenshot.

This is the OpenCLI counterpart of `my-mcp` `scrape`, without `profile_mode=master`: the host browser already carries login cookies. Adapter commands run in OpenCLI's owned **automation** window, not in the tab you are looking at.

## Isolation

| Mode | What happens | Disturbs the user's current tab? |
|------|----------------|----------------------------------|
| `--window background` (default) | Reuse/create the OpenCLI automation window with `focused: false` | No. Does not steal focus. The automation window is still a normal 1280×900 window (taskbar/Alt-Tab visible). |
| `--window foreground` | Same owned window, then `chrome.windows.update({ focused: true })` | No tab steal; the automation window is brought to the front on purpose. |

`siteSession` is **ephemeral**: each call gets its own owned tab in the automation window and the lease is released afterwards. ChatGPT/Jimeng persistent tabs in that window are not closed.

There is no hidden/offscreen Chrome window in current OpenCLI. Background means **unfocused**, not invisible.

## Usage

```bash
# default: background window, full page markdown
opencli utils scrape https://example.com

# main-content extraction (my-mcp only_main_content)
opencli utils scrape https://example.com --only-main-content true

# watch the automation window
opencli utils scrape https://example.com --window foreground

# links / viewport screenshot / full-page screenshot
opencli utils scrape https://example.com --as links
opencli utils scrape https://example.com --as screenshot
opencli utils scrape https://example.com --as fullscreenshot
```

`--as` is the scrape payload kind. CLI envelope format remains `-f json|table|plain|...` (this command defaults to JSON).

Artifacts are always written under `$TMPDIR/opencli-scrape/` (screenshots, direct media, and the full markdown/links payload).

JSON shape: `title`, `url`, `as`, `chars`, `truncated`, `content`, `links`, `files`, `text`.
If `chars > 10000`, `truncated=true`, `content`/`links` are emptied, and `text` only says the body exceeded 10k and lists `files`. Read the saved `.md` for the full document.

## Pipeline

Rendered HTML is collected after the my-mcp smart wait (text-length stability, then leftover network-idle if it does not settle). Direct media URLs (`pdf`/`png`/`zip`/…) are fetched with host cookies and saved as files. Browser-context fetch is preferred; a cookie-scoped Node fetch is used only when browser CORS blocks it. Direct-media transfer is capped at 8 MiB to bound browser/CLI memory; larger files fail explicitly instead of returning a partial artifact.

The artifact directory is private (`0700`) and newly created files are private (`0600`) on POSIX systems. Failed or timed-out writes are removed best-effort.

The Node fallback requests only the requested URL and explicit `http(s)` redirects. It re-reads host cookies for each redirect destination, so cookies from one origin are not forwarded to another.

Frame tree: same-origin `iframe`/`frame` walks keep parent/depth; each OpenCLI cross-origin frame is evaluated and walked again for nested same-origin documents, then attached to the embedding parent when the `src` matches. Nested cross-origin-under-cross-origin is still truncated by OpenCLI `page.frames()`.

HTML is cleaned with the my-mcp algorithm:

1. `HtmlCleaner` — strip chrome, lazy-image promotion, scored main-content selection
2. Turndown + GFM — HTML → Markdown (JS stand-in for Java flexmark)
3. `MarkdownPostProcessor` — empty links, tables, ordered lists, adjacent fences
4. `ContentSourceSelector` — when `--only-main-content true`, pick the best of main vs iframe sources

## Install

```bash
opencli plugin install /path/to/my-opencli/packages/utils
opencli utils scrape --help
```
