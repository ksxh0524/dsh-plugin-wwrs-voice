# dsh-plugin-wwrs-voice

[中文](./README.zh.md)

Voice generation DSH plugin (open source): MiniMax TTS, VoxCPM2 and voice design behind one facade. Sole runtime dependency is @deepseek-ai/dsh-tools (defineTool DSL). W1 landed: four tools behind one facade (`voice_synthesize` fully implements MiniMax T2A; `voice_clone` / `voice_design` are `experimental`).

## Tools

All four tools read or write under the configured workspace and are covered by the write guard.

| Tool                 | Params                                                                                                                                                           | Semantics                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `voice_synthesize`   | `text` (over-long rejected, call in chunks), `voiceId`, `model`, `outputPath` (.mp3, in-workspace), `speed?` (0.5–2), `emotion?`, `overwrite?` (default `false`) | MiniMax T2A full implementation → mp3 plus word timestamps; `voiceId`/`model` are explicit, never defaulted              |
| `voice_clone`        | `text`, `refAudio` (existing in-workspace audio), `outputPath`, `seed?`, `overwrite?` (default `false`)                                                          | `experimental` — validates inputs only (v1 does NOT synthesize), then guides the caller to the matching comfyui template |
| `voice_design`       | `text`, `instruct`, `outputPath`, `seed?`, `overwrite?` (default `false`)                                                                                        | `experimental` — validates inputs only (v1 does NOT synthesize), then guides the caller to the matching comfyui template |
| `pronunciation_dict` | —                                                                                                                                                                | Built-in corrections merged with `<workspace>/.wwrs/pronunciation-dict.json` when present                                |

## Contract

Remote MiniMax T2A behind the `voice_synthesize` facade (direct fetch, disk write, word timestamps). `voice_clone` / `voice_design` make no Comfy calls — they validate inputs and guide the caller to the matching `dsh-plugin-wwrs-comfyui` template. Credentials come from the environment only (`MINIMAX_API_KEY`; missing key fails loud, no fallback).

## Config

| Key         | Meaning                      | Default                                         |
| ----------- | ---------------------------- | ----------------------------------------------- |
| `workspace` | Project root (absolute path) | `WWRS_WORKSPACE` env, then neutral-anchor probe |

Workspace resolution: `config.workspace` > env `WWRS_WORKSPACE` > upward probe for `.wwrs/workspace.json` > fail loud. Point `workspace` at an absolute project root so voice artifacts land in a known place. Initial RPM quotas follow the legacy tiers and are configurable: synthesize 10/min, clone 60/min, design 20/min. Retries default to 2 and apply to 429/5xx only (4xx and provider business codes never retry). Missing values fail loud with guidance; never silently degrade.

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

## Verify

Run `pnpm check` (`prettier --check` + `tsc --noEmit` + `node --test tests/*.test.ts`).

## No browser half

Server-side tools only — `pnpm check` is the full gate, no `check:browser` chain.

## Known limits

- `voice_clone` / `voice_design` are `experimental`: v1 validates inputs only and guides the caller to the matching comfyui template — no Comfy calls leave this package.
- `voice_synthesize` never defaults `voiceId`/`model`; over-long text is rejected (call in chunks).
- Retries apply to 429/5xx only (4xx and provider business codes never retry).
- `pronunciation_dict` merges the workspace custom file only when present.

## License

MIT.
