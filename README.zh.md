# dsh-plugin-wwrs-voice

语音生成 DSH 插件（开源）：MiniMax TTS、VoxCPM2 与音色设计收敛到同一立面之后。零运行时依赖。

## 状态

W0 空壳：挂载层（`src/cordis.ts`）、守卫壳与标准门已绿。工具实现在 W1 落地。当前空壳只接线层 id `wwrs-voice`、工作区解析与写保护守卫，尚不产生任何音频。

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

工作区缺失即大声失败并给出路；绝不静默降级。请把 `workspace` 指向绝对路径的项目根，以便 W1 语音产物落到已知位置。

## 工具（W1）

`voice_synthesize` / `voice_clone` / `voice_design` / `pronunciation_dict`。

W1 将 MiniMax TTS 合成、声音复刻与音色设计收敛到同一立面，并以发音词典做纠音。四个工具的产物都写到已配置的工作区之下，并受写保护守卫覆盖。

## 许可

MIT.
