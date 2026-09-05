# gemini-agent (OpenCLI plugin)

Protocol-first Gemini web adapter for `https://gemini.google.com/app`:

1. Open a visible ephemeral tab → arm `startNetworkCapture(StreamGenerate)` → native type → trusted structural send click
2. Collect the batchexecute `wrb.fr` stream for text / image URLs / conversation id
3. Images: protocol metadata plus newly appeared generated-image tiles → Gemini's stable download control → Browser Bridge download → `--op`
4. Uploads: sequential `setFileInput` after opening the composer `+` control by structure, not by locale labels

No DOM transcript fallback. Localized strings such as 发送 / Send are not used.

## Requirements

| Host | Minimum | Current verified release |
|------|---------|--------------------------|
| `@jackwener/opencli` (fork) | `>=1.8.7` | package `1.8.7-fengwk.9` |
| Browser Bridge / Extension | `>=1.0.30` | paired Extension `1.0.30` |

Needs fork APIs: `page.startNetworkCapture` / `page.readNetworkCapture`, `page.setFileInput`, `page.nativeType` / raw CDP input, `page.waitForDownload`, and `Arg.repeatable` for multi `--file`.

The command defaults to `siteSession: ephemeral` and a foreground window. Gemini ignores trusted mouse/keyboard submission while a reused tab is hidden; conversation continuity is preserved explicitly with `--session`, not by reusing the same browser tab.

## Install

```bash
opencli plugin install /path/to/my-opencli/packages/gemini-agent
```

Hub / remote:

```bash
opencli plugin install github:fengwk/my-opencli/gemini-agent
```

## Usage

```bash
opencli gemini-agent ask '用一句话说明 Docker 是做什么的' --timeout 180
opencli gemini-agent ask '继续' --session <conversationId>
opencli gemini-agent ask '读这两个附件并概括' --file ./a.txt --file ./b.png
opencli gemini-agent ask '画一只坐在窗台上的橘猫，暖色侧光' --op ~/Pictures/gemini-agent
```

`--session` accepts a bare id, `/app/<id>`, a full conversation URL, or protocol `c_<id>`.
