# dsh-plugin-wwrs-voice

Voice generation DSH plugin (open source): MiniMax TTS, VoxCPM2 and voice design behind one facade. Zero runtime dependencies.

## Status

W0 shell: mount layer (`src/cordis.ts`), guard shell, and standard gates are green. Tool implementations land in W1. This shell only wires the layer id `wwrs-voice`, workspace resolution, and the write guard; no audio is produced yet.

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

Missing workspace fails loud with guidance; never silently degrade. Point `workspace` at an absolute project root so W1 voice artifacts land in a known place.

## Tools (W1)

`voice_synthesize` / `voice_clone` / `voice_design` / `pronunciation_dict`.

W1 puts MiniMax TTS synthesis, voice cloning, and voice design behind one facade, with a pronunciation dictionary for corrections. All four tools write artifacts under the configured workspace and are covered by the write guard.

## License

MIT.
