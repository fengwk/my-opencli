# gemini-agent (OpenCLI plugin)

Protocol-first Gemini web adapter for `https://gemini.google.com/app`:

1. Keep/reuse a visible foreground tab → arm `startNetworkCapture(StreamGenerate)` → native type → trusted structural send click
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

The command defaults to `siteSession: persistent` and `defaultWindowMode: foreground`. A persistent fixed site tab is kept/reused across turns, while foreground remains mandatory because Gemini ignores trusted mouse/keyboard submission when the tab is hidden or unfocused. Conversation continuity is still explicit via `--session` (conversation id or `/app/<id>` URL), not inferred merely from whatever was left open on the tab.

## Capability boundary

The public arguments and output columns intentionally match `chatgpt-agent`, but model-native capabilities are not fabricated to fill that schema:

- Text, repeatable attachment input, image understanding, image generation/editing, explicit session continuation, persistent tab reuse, and image export are supported.
- `files` remains an optional shared output column. The current Gemini protocol collector does not export arbitrary model-generated files, so callers should normally expect `[]`.
- Gemini must run in a foreground tab; this operational constraint intentionally differs from ChatGPT.
- `source`, protocol completion events, citation richness, and image metadata are site-specific even though Hub normalization returns the same top-level shape.

## Install

```bash
opencli plugin install /absolute/path/to/my-opencli/packages/gemini-agent
```

Hub / remote:

```bash
opencli plugin install github:fengwk/my-opencli/gemini-agent
```

## Usage

```bash
opencli gemini-agent ask '用一句话说明 Docker 是做什么的' --timeout 180
opencli gemini-agent ask '继续' --session "<conversationId>"
opencli gemini-agent ask '读这两个附件并概括' --file "/absolute/path/to/a.txt" --file "/absolute/path/to/b.png"
opencli gemini-agent ask '画一只坐在窗台上的橘猫，暖色侧光' --op "/absolute/path/to/output"
```

`--session` accepts a bare id, `/app/<id>`, a full conversation URL, or protocol `c_<id>`.
