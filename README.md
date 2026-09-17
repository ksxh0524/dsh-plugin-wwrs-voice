# dsh-plugin-wwrs-voice

Voice generation DSH plugin (open source): MiniMax TTS, VoxCPM2 and voice design behind one facade. Zero runtime dependencies.

## Status

W1 landed: four tools behind one facade. `voice_synthesize` fully implements MiniMax T2A (direct fetch, disk write, word timestamps); `voice_clone` / `voice_design` v1 validate inputs and guide the caller to the matching dsh-plugin-wwrs-comfyui template (both marked `experimental`, no Comfy calls); `pronunciation_dict` reads the built-in corrections merged with the workspace custom file.

## Install

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-voice": "link:/path/to/plugin-wwrs-voice"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-voice"] } }
}
```

Link-install the package into the host profile and enable the `dsh-plugin-wwrs-voice` bundle. Restart the host so the `wwrs-voice` layer mounts; the shell logs its workspace source on boot.

## Config

| Key         | Meaning                      | Default                                         |
| ----------- | ---------------------------- | ----------------------------------------------- |
| `workspace` | Project root (absolute path) | `WWRS_WORKSPACE` env, then neutral-anchor probe |

Missing workspace fails loud with guidance; never silently degrade. Point `workspace` at an absolute project root so voice artifacts land in a known place.

Credentials come from the environment only: `MINIMAX_API_KEY` (missing key fails loud, no fallback). Initial RPM quotas follow the legacy tiers and are configurable: synthesize 10/min, clone 60/min, design 20/min. Retries default to 2 and apply to 429/5xx only (4xx and provider business codes never retry).

## Tools (W1)

`voice_synthesize` / `voice_clone` / `voice_design` / `pronunciation_dict`.

`voice_synthesize{text, voiceId, model, outputPath, speed?, emotion?, overwrite?}` synthesizes narration to mp3 plus word timestamps (`voiceId`/`model` are explicit, never defaulted; `overwrite` defaults to false; over-long text is rejected for chunked calls). `voice_clone` / `voice_design` validate their inputs and return guidance toward the matching dsh-plugin-wwrs-comfyui template (`experimental`). `pronunciation_dict` returns built-in corrections merged with `<workspace>/.wwrs/pronunciation-dict.json` when present. All four tools write or read under the configured workspace and are covered by the write guard.

## License

MIT.
