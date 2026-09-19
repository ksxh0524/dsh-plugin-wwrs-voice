# dsh-plugin-wwrs-voice

[English](./README.md)

语音生成 DSH 插件（开源）：MiniMax TTS、VoxCPM2 与音色设计收敛到同一立面之后。唯一运行时依赖是 @deepseek-ai/dsh-tools（defineTool DSL）。W1 已落地：同一立面后四个工具（`voice_synthesize` 全实现 MiniMax T2A；`voice_clone` / `voice_design` 标 `experimental`）。

## 工具

四个工具的读写都在已配置的工作区之下，并受写保护守卫覆盖。

| 工具                 | 参数                                                                                                                                           | 语义                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `voice_synthesize`   | `text`（超长拒收，请分段调）、`voiceId`、`model`、`outputPath`（工作区内 `.mp3`）、`speed?`（0.5–2）、`emotion?`、`overwrite?`（缺省 `false`） | MiniMax T2A 全实现 → mp3 并附词时间戳；`voiceId`/`model` 显式传入、不代选  |
| `voice_clone`        | `text`、`refAudio`（工作区内已存在音频）、`outputPath`、`seed?`、`overwrite?`（缺省 `false`）                                                  | `experimental`——v1 只做参数校验不合成，校验后指引调用方调对应 comfyui 模板 |
| `voice_design`       | `text`、`instruct`、`outputPath`、`seed?`、`overwrite?`（缺省 `false`）                                                                        | `experimental`——v1 只做参数校验不合成，校验后指引调用方调对应 comfyui 模板 |
| `pronunciation_dict` | —                                                                                                                                              | 内置纠音与 `<工作区>/.wwrs/pronunciation-dict.json`（若有）的合并          |

## 合同

远端 MiniMax T2A 收敛到 `voice_synthesize` 门面之后（直调、落盘、词时间戳）。`voice_clone` / `voice_design` 不直调 Comfy——只做参数校验并指引调用方调 dsh-plugin-wwrs-comfyui 对应模板。凭据只走环境变量（`MINIMAX_API_KEY`；缺失即大声失败，无回落）。

## 配置

| 键          | 含义               | 缺省                                    |
| ----------- | ------------------ | --------------------------------------- |
| `workspace` | 项目根（绝对路径） | `WWRS_WORKSPACE` 环境变量，再中性锚探测 |

工作区解析：`config.workspace` > 环境变量 `WWRS_WORKSPACE` > 向上探测 `.wwrs/workspace.json` > 大声失败。请把 `workspace` 指向绝对路径的项目根，以便语音产物落到已知位置。初始 RPM 配额沿用老分档且可配置：合成 10/分、复刻 60/分、设计 20/分。重试缺省 2 次，只对 429/5xx 生效（4xx 与提供商业务码永不重试）。缺失即大声失败并给出路；绝不静默降级。

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

## 验证

跑 `pnpm check`（prettier 检查 + `tsc --noEmit` + `node --test tests/*.test.ts`）。

## 无浏览器半

纯服务端工具——`pnpm check` 即全部门，无 `check:browser` 链。

## 已知边界

- `voice_clone` / `voice_design` 标 `experimental`：v1 只做参数校验并指引调用方调对应 comfyui 模板——本包不打出任何 Comfy 调用。
- `voice_synthesize` 永不代选 `voiceId`/`model`；超长文本拒收（请分段调）。
- 重试只对 429/5xx 生效（4xx 与提供商业务码永不重试）。
- `pronunciation_dict` 只在工作区自定义文件存在时才合并。

## 许可

MIT.
