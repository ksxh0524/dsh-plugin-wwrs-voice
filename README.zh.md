# dsh-plugin-wwrs-voice

语音生成 DSH 插件（开源）：MiniMax TTS、VoxCPM2 与音色设计收敛到同一立面之后。唯一运行时依赖是 @deepseek-ai/dsh-tools（defineTool DSL）。

## 状态

W1 已落地：同一立面后四个工具。`voice_synthesize` 全实现 MiniMax T2A（直调、落盘、词时间戳）；`voice_clone` / `voice_design` v1 只做参数校验并指引调用方调 dsh-plugin-wwrs-comfyui 对应模板（均标 `experimental`，不直调 Comfy）；`pronunciation_dict` 读内置纠音合并工作区自定义文件。

## 安装

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-voice": "link:/path/to/plugin-wwrs-voice"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-voice"] } }
}
```

将本包 link 安装进宿主 profile 并启用 `dsh-plugin-wwrs-voice` 包。重启宿主使 `wwrs-voice` 层挂载；空壳会在启动日志中打印工作区来源。

## 配置

| 键          | 含义               | 缺省                                    |
| ----------- | ------------------ | --------------------------------------- |
| `workspace` | 项目根（绝对路径） | `WWRS_WORKSPACE` 环境变量，再中性锚探测 |

工作区缺失即大声失败并给出路；绝不静默降级。请把 `workspace` 指向绝对路径的项目根，以便语音产物落到已知位置。

凭据只走环境变量：`MINIMAX_API_KEY`（缺失即大声失败，无回落）。初始 RPM 配额沿用老分档且可配置：合成 10/分、复刻 60/分、设计 20/分。重试缺省 2 次，只对 429/5xx 生效（4xx 与提供商业务码永不重试）。

## 工具（W1）

`voice_synthesize` / `voice_clone` / `voice_design` / `pronunciation_dict`。

`voice_synthesize{text, voiceId, model, outputPath, speed?, emotion?, overwrite?}` 合成旁白为 mp3 并附词时间戳（`voiceId`/`model` 显式传入、不代选；`overwrite` 缺省 false；超长文本拒收请分段调）。`voice_clone` / `voice_design` 校验入参后返回指引，指向 dsh-plugin-wwrs-comfyui 对应模板（`experimental`）。`pronunciation_dict` 返回内置纠音与 `<工作区>/.wwrs/pronunciation-dict.json`（若有）的合并。四个工具的读写都在已配置的工作区之下，并受写保护守卫覆盖。

## 验证

跑 `pnpm check`（prettier 检查 + `tsc --noEmit` + `node --test tests/*.test.ts`）。

## 许可

MIT.
