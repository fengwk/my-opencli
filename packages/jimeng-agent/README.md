# jimeng-agent (OpenCLI plugin)

Prepare-only Jimeng Agent workflow for video prompts with local references.

The `ask` command:

1. Selects Agent mode.
2. Opens the generation-preference panel by DOM structure.
3. Enables the Auto switch and selects the video radio when necessary.
4. Uploads image, video, and audio references through the native file input.
5. Replaces `@图片N`, `@视频N`, and `@音频N` placeholders with Jimeng rich mentions.
6. Stops with the completed draft still in the composer.

It never clicks the send/generate control.

## Install

```bash
opencli plugin install /path/to/my-opencli/packages/jimeng-agent
opencli jimeng-agent ask --help
```

## Example

```bash
opencli jimeng-agent ask \
  --workspace <workspace-id> \
  --image ./人物.png \
  --prompt '请以@图片1作为人物形象参考。' \
  --duration 5 \
  --ratio 16:9 \
  --model_version seedance2.0
```

Reference flags are repeatable. Labels are assigned independently by media kind
and upload order: `图片1`, `图片2`, `视频1`, `音频1`, and so on.

## Safety boundary

- Mention selection uses Enter only after a synchronous capture-phase guard
  confirms the unique candidate, active suggestion, editor focus, and collapsed
  selection are still valid.
- If the picker changes before keydown, Enter is blocked before Jimeng receives
  it.
- A successful result includes `submitted: false`; the completed prompt remains
  visible in the editor for human review.

## WSL + Windows Chrome

Windows Chrome cannot upload WSL paths directly. The plugin creates a disposable
Windows-visible alias directory and copies each reference using its Jimeng label
as the filename, such as `图片1.png`. The directory is removed when the command
finishes.

Optional environment variables:

- `OPENCLI_JIMENG_UPLOAD_ALIAS_ROOT`: override the disposable alias root.
- `OPENCLI_UPLOAD_STAGE=0|1`: disable or force Windows upload staging.
- `OPENCLI_JIMENG_MENTION_DEBUG=1`: capture mention screenshots and DOM state.
- `OPENCLI_JIMENG_MENTION_DEBUG_STOP=before-click|after-click`: preserve a
  diagnostic checkpoint; the historical phase names are retained for
  compatibility.
