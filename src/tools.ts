/** tools.ts —— dsh-plugin-wwrs-voice DSH 工具面（W1 落地；defineTool 写法对齐管线簇）。
 *
 * 注册面（cordis apply 一次性 register）：
 * - voice_synthesize：MiniMax T2A 全实现（text/voiceId/model 显式参数，直调 + 落盘 + 词时间戳）；
 * - voice_clone：v1 只做参数校验 + 指引调用方调 dsh-plugin-wwrs-comfyui 对应模板（experimental）；
 * - voice_design：v1 同上（experimental）；
 * - pronunciation_dict：读内置发音词典 + 工作区自定义词典合并。
 *
 * 铁律（作业单五包一致）：
 * - 零业务名词：只懂 text/voiceId/音频字节；不收 voice-manifest，不透传业务 endpointKind。
 * - 工作区：config.workspace > env WWRS_WORKSPACE > 向上找 .wwrs/workspace.json > fail-loud；
 *   产物路径一律归一到工作区内，overwrite 缺省 false。
 * - 凭据只走 env MINIMAX_API_KEY；缺失 fail-loud。
 * - 执行面：fetch 直调 T2A；RPM 窗限流（老分档数字为初始配额，走配置可覆写）；
 *   429/5xx 退避重试（缺省 2 次），4xx/业务码不重试；exec.signal 下钻到 fetch。
 * - defineTool 全带 output.render（缺 render = userRender is not a function，boot 期报）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveWorkspace } from "./lib/workspace.ts";
import { createVoiceRateLimiter, defaultVoiceLimiter, type RateQuota, type VoiceOperation, type VoiceRateLimiter } from "./lib/rate-limit.ts";
import { DEFAULT_PRONUNCIATION_DICT, fetchSubtitleJson, MAX_TEXT_CHARS, MINIMAX_API_KEY_ENV, MinimaxApiError, synthesizeBlock } from "./engine/minimax.ts";
import { parseWordStamps } from "./engine/timestamps.ts";
import type { ToolExec } from "./lib/host.ts";

/** 工具收据形状（管线簇同族：verdict/summary/details）。 */
type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];
type VoiceReceipt = { verdict: string; summary: string; details: Record<string, JsonValue> };

/** 工具宿主配置（注册期闭包注入；fetchImpl=测试/边缘注入，缺省全局 fetch）。 */
export type VoiceToolsHost = {
  workspace?: string;
  quotas?: Partial<Record<VoiceOperation, RateQuota>>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", required: true },
    summary: { type: "string", required: true },
    details: { type: "object", additionalProperties: true },
  },
} as const;

function renderSummary(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: String((value as VoiceReceipt)?.summary ?? "") }];
}

function okReceipt(summary: string, details: Record<string, JsonValue> = {}): VoiceReceipt {
  return { verdict: "ok", summary, details };
}

function errorReceipt(tool: string, message: string, details: Record<string, JsonValue> = {}): VoiceReceipt {
  const msg = message.slice(0, 2000);
  return { verdict: "error", summary: `${tool} 失败：${msg}`, details: { tool, error: msg, ...details } };
}

/** 硬错误收口（引擎抛飞的统一收据；MinimaxApiError 带状态码供调用方判重试）。 */
function engineErrorReceipt(tool: string, e: unknown): VoiceReceipt {
  if (e instanceof MinimaxApiError) {
    return errorReceipt(tool, e.message, { status: typeof e.status === "number" ? e.status : null });
  }
  const msg = e instanceof Error ? e.message || String(e) : String(e);
  return errorReceipt(tool, msg);
}

function readStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** 工具落点工作区：config.workspace 优先，否则自会话 cwd 向上找锚（三类全 miss 即抛三条出路）。 */
export function resolveVoiceWorkspace(exec: ToolExec | undefined, host?: VoiceToolsHost): string {
  if (host?.workspace) return resolve(host.workspace);
  const cwd = String(exec?.agent?.session?.meta?.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd());
  return resolveWorkspace({ cwd, env: host?.env });
}

/** 路径归一到工作区内：出界即抛（守卫谓词同口径，见 lib/guard-predicate.ts）。 */
export function resolveInsideWorkspace(ws: string, rawPath: string, label: string): string {
  const abs = resolve(ws, rawPath);
  const rel = relative(ws, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${"/"}`)) {
    throw new Error(`${label}须落在工作区内（工作区 ${ws}，收到 ${rawPath}）`);
  }
  return abs;
}

const limiterCache = new WeakMap<object, VoiceRateLimiter>();

function limiterOf(host: VoiceToolsHost | undefined): VoiceRateLimiter {
  if (!host) return defaultVoiceLimiter;
  if (!host.quotas) return defaultVoiceLimiter;
  // 按配置自建实例须随 host 复用——每次新建则跨调用记账丢失，配额永不触发。
  let limiter = limiterCache.get(host);
  if (!limiter) {
    limiter = createVoiceRateLimiter(host.quotas);
    limiterCache.set(host, limiter);
  }
  return limiter;
}

function say(exec: ToolExec | undefined, text: string): void {
  exec?.onProgress?.({ content: [{ type: "text", text }] });
}

/** 输出路径通用校验：必填 + 工作区内 + 已存在且非 overwrite 即拒。返回落盘绝对路径。 */
function checkOutputPath(args: Record<string, unknown>, ws: string, tool: string): { abs: string; overwrite: boolean } | VoiceReceipt {
  const outputPath = readStr(args, "outputPath").trim();
  if (!outputPath) return errorReceipt(tool, "outputPath 必填（工作区相对路径或工作区内绝对路径）");
  let abs: string;
  try {
    abs = resolveInsideWorkspace(ws, outputPath, "outputPath");
  } catch (e) {
    return errorReceipt(tool, e instanceof Error ? e.message : String(e));
  }
  const overwrite = args.overwrite === true;
  if (!overwrite && existsSync(abs)) {
    return errorReceipt(tool, `输出已存在且未传 overwrite=true：${abs}（不替调用方覆盖，缺省 false）`);
  }
  return { abs, overwrite };
}

function isReceipt(v: unknown): v is VoiceReceipt {
  return !!v && typeof v === "object" && typeof (v as VoiceReceipt).verdict === "string";
}

// ---------- voice_synthesize（MiniMax T2A 全实现） ----------

export function makeVoiceSynthesizeTool(host?: VoiceToolsHost): unknown {
  return defineTool({
    name: "voice_synthesize",
    description:
      "Synthesize narration audio via MiniMax T2A (full implementation): text + explicit voiceId/model → mp3 + word timestamps. Params: text（必填，≤10000字） + voiceId（必填，显式音色 id） + model（必填，显式模型 id，不代选） + outputPath（必填，工作区内，.mp3） + optional speed（0.5–2）/emotion + optional overwrite（缺省 false）。凭据走 env MINIMAX_API_KEY；RPM 窗限流（合成 10/分，可配）。",
    parameters: {
      text: { type: "string", required: true, description: "待合成文本（必填，非空，≤10000 字符；>3000 自动走流式）" },
      voiceId: { type: "string", required: true, description: "音色 id（必填，显式传入，本工具不代选）" },
      model: { type: "string", required: true, description: "合成模型 id（必填，显式传入，本工具不代选）" },
      outputPath: { type: "string", required: true, description: "输出音频路径（必填，工作区内，须 .mp3 后缀）" },
      speed: { type: "number", description: "可选；语速 0.5–2（缺省 1）" },
      emotion: { type: "string", description: "可选；情感标记（非空字符串，原样透传）" },
      overwrite: { type: "boolean", description: "可选；输出已存在时是否覆盖（缺省 false）" },
    },
    output: {
      schema: RECEIPT_SCHEMA,
      render: renderSummary,
    },
    async execute(rawArgs, rawExec): Promise<VoiceReceipt> {
      const tool = "voice_synthesize";
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const exec = rawExec as unknown as ToolExec; // DSH 运行时实传 ToolRunContext + onProgress（类型面滞后），窄脸收口
      let ws: string;
      try {
        ws = resolveVoiceWorkspace(exec, host);
      } catch (e) {
        return errorReceipt(tool, e instanceof Error ? e.message : String(e));
      }
      const text = readStr(args, "text").trim();
      if (!text) return errorReceipt(tool, "text 必填（非空字符串）");
      if (text.length > MAX_TEXT_CHARS) {
        return errorReceipt(tool, `text 超长：${text.length} 字符，上限 ${MAX_TEXT_CHARS}（请分段调用）`, {
          chars: text.length,
          maxChars: MAX_TEXT_CHARS,
        });
      }
      const voiceId = readStr(args, "voiceId").trim();
      if (!voiceId) return errorReceipt(tool, "voiceId 必填（显式音色 id，本工具不代选）");
      const model = readStr(args, "model").trim();
      if (!model) return errorReceipt(tool, "model 必填（显式模型 id，本工具不代选）");
      let speed: number | undefined;
      if (args.speed !== undefined) {
        if (typeof args.speed !== "number" || !Number.isFinite(args.speed) || args.speed < 0.5 || args.speed > 2) {
          return errorReceipt(tool, `speed 只收 0.5–2 的数字（收到 ${String(args.speed).slice(0, 40)}）`);
        }
        speed = args.speed;
      }
      const emotionRaw = readStr(args, "emotion").trim();
      if (args.emotion !== undefined && !emotionRaw) return errorReceipt(tool, "emotion 传了即须为非空字符串");
      const checked = checkOutputPath(args, ws, tool);
      if (isReceipt(checked)) return checked;
      if (!checked.abs.toLowerCase().endsWith(".mp3")) {
        return errorReceipt(tool, `outputPath 须为 .mp3 后缀（引擎只产 mp3，收到 ${readStr(args, "outputPath").trim().slice(0, 80)}）`);
      }
      const env = host?.env ?? process.env;
      const apiKey = String(env[MINIMAX_API_KEY_ENV] ?? "").trim();
      if (!apiKey) {
        return errorReceipt(tool, `${MINIMAX_API_KEY_ENV} 缺失：凭据只走环境变量（export ${MINIMAX_API_KEY_ENV}=<key> 后重试）`);
      }
      const admission = limiterOf(host).tryAcquire("synthesize");
      if (!admission.ok) {
        return errorReceipt(tool, `合成 RPM 窗已满（10/分，${admission.retryAfterMs}ms 后重试）`, {
          retryAfterMs: admission.retryAfterMs,
        });
      }
      say(exec, `[${tool}] 合成中（${text.length}字 voiceId=${voiceId}）…`);
      try {
        const out = await synthesizeBlock(text, {
          apiKey,
          model,
          voiceId,
          ...(speed !== undefined ? { speed } : {}),
          ...(emotionRaw ? { emotion: emotionRaw } : {}),
          retries: 2,
          signal: exec?.signal,
          fetchImpl: host?.fetchImpl,
        });
        mkdirSync(dirname(checked.abs), { recursive: true });
        writeFileSync(checked.abs, out.audio);
        // 词时间戳：字幕下载 best-effort——失败不整体失败，空戳+注记回执。
        let timestamps: JsonValue = [];
        let timestampNote = "";
        if (out.subtitleUrl) {
          try {
            const sub = await fetchSubtitleJson(out.subtitleUrl, { signal: exec?.signal, fetchImpl: host?.fetchImpl });
            const stamps = parseWordStamps(sub);
            timestamps = stamps.map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs }));
            if (!stamps.length) timestampNote = "字幕已下载但未解析出词时间戳（形态未覆盖，见 subtitleUrl 原件）";
          } catch (e) {
            timestampNote = `字幕下载/解析失败，已交付音频：${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
          }
        } else {
          timestampNote = "本次回执无字幕下载地址，未取词时间戳";
        }
        const details: Record<string, JsonValue> = {
          audioPath: checked.abs,
          durationMs: out.durationMs,
          chars: text.length,
          model,
          voiceId,
          timestamps,
          timestampCount: Array.isArray(timestamps) ? timestamps.length : 0,
        };
        if (speed !== undefined) details.speed = speed;
        if (emotionRaw) details.emotion = emotionRaw;
        if (out.subtitleUrl) details.subtitleUrl = out.subtitleUrl;
        if (timestampNote) details.timestampNote = timestampNote;
        return okReceipt(
          `合成完成：${checked.abs}（${text.length}字，${out.durationMs}ms，词戳 ${Array.isArray(timestamps) ? timestamps.length : 0} 条）`,
          details,
        );
      } catch (e) {
        return engineErrorReceipt(tool, e);
      }
    },
  });
}

// ---------- voice_clone（v1：校验 + 指引 comfyui，experimental） ----------

const CLONE_GUIDANCE =
  "v1 未直调 Comfy 系执行：本包 v1 不直调 Comfy（跨插件调用二期 spike 前，" +
  "复刻执行走 dsh-plugin-wwrs-comfyui 对应模板）。调用方请持本回执的校验结论，" +
  "改调 dsh-plugin-wwrs-comfyui 的声音复刻模板（text + refAudio + 输出路径同参带过去）。";

export function makeVoiceCloneTool(host?: VoiceToolsHost): unknown {
  return defineTool({
    name: "voice_clone",
    description:
      "[experimental] Validate voice-cloning inputs only (v1 does NOT synthesize): validates text/refAudio/outputPath, then guides the caller to run the matching dsh-plugin-wwrs-comfyui template. Params: text（必填） + refAudio（必填，工作区内已存在音频） + outputPath（必填，工作区内） + optional seed（非负整数）/overwrite（缺省 false）。",
    parameters: {
      text: { type: "string", required: true, description: "待合成文本（必填，非空）" },
      refAudio: { type: "string", required: true, description: "参考音频路径（必填，工作区内已存在文件）" },
      outputPath: { type: "string", required: true, description: "期望输出路径（必填，工作区内；v1 只校验不写）" },
      seed: { type: "integer", description: "可选；随机种子（非负整数，原样带给 comfyui 模板）" },
      overwrite: { type: "boolean", description: "可选；输出已存在时是否允许覆盖（缺省 false，v1 只校验）" },
    },
    output: {
      schema: RECEIPT_SCHEMA,
      render: renderSummary,
    },
    async execute(rawArgs, rawExec): Promise<VoiceReceipt> {
      const tool = "voice_clone";
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const exec = rawExec as unknown as ToolExec; // DSH 运行时实传 ToolRunContext（类型面滞后），窄脸收口
      let ws: string;
      try {
        ws = resolveVoiceWorkspace(exec, host);
      } catch (e) {
        return errorReceipt(tool, e instanceof Error ? e.message : String(e));
      }
      const text = readStr(args, "text").trim();
      if (!text) return errorReceipt(tool, "text 必填（非空字符串）");
      const refAudioRaw = readStr(args, "refAudio").trim();
      if (!refAudioRaw) return errorReceipt(tool, "refAudio 必填（工作区内已存在音频路径）");
      let refAudioAbs: string;
      try {
        refAudioAbs = resolveInsideWorkspace(ws, refAudioRaw, "refAudio");
      } catch (e) {
        return errorReceipt(tool, e instanceof Error ? e.message : String(e));
      }
      try {
        if (!statSync(refAudioAbs).isFile()) return errorReceipt(tool, `refAudio 不是文件：${refAudioAbs}`);
      } catch {
        return errorReceipt(tool, `refAudio 不存在：${refAudioAbs}（先把参考音频放到工作区内）`);
      }
      const checked = checkOutputPath(args, ws, tool);
      if (isReceipt(checked)) return checked;
      if (args.seed !== undefined && (!Number.isInteger(args.seed) || (args.seed as number) < 0)) {
        return errorReceipt(tool, `seed 只收非负整数（收到 ${String(args.seed).slice(0, 40)}）`);
      }
      return {
        verdict: "experimental",
        summary: `${tool} [experimental] 参数校验通过（text ${text.length}字，refAudio 已存在），${CLONE_GUIDANCE}`,
        details: {
          tool,
          stage: "validate-only",
          textChars: text.length,
          refAudio: refAudioAbs,
          outputPath: checked.abs,
          ...(args.seed !== undefined ? { seed: args.seed as number } : {}),
          guidance: CLONE_GUIDANCE,
        },
      };
    },
  });
}

// ---------- voice_design（v1：校验 + 指引 comfyui，experimental） ----------

const DESIGN_GUIDANCE =
  "v1 未直调 Comfy 系执行：本包 v1 不直调 Comfy（跨插件调用二期 spike 前，" +
  "音色设计执行走 dsh-plugin-wwrs-comfyui 对应模板）。调用方请持本回执的校验结论，" +
  "改调 dsh-plugin-wwrs-comfyui 的音色设计模板（text + instruct + 输出路径同参带过去）。";

export function makeVoiceDesignTool(host?: VoiceToolsHost): unknown {
  return defineTool({
    name: "voice_design",
    description:
      "[experimental] Validate voice-design inputs only (v1 does NOT synthesize): validates text/instruct/outputPath, then guides the caller to run the matching dsh-plugin-wwrs-comfyui template. Params: text（必填） + instruct（必填，音色描述） + outputPath（必填，工作区内） + optional seed（非负整数）/overwrite（缺省 false）。",
    parameters: {
      text: { type: "string", required: true, description: "待合成文本（必填，非空）" },
      instruct: { type: "string", required: true, description: "音色描述（必填，非空，如「年轻女声、温柔」）" },
      outputPath: { type: "string", required: true, description: "期望输出路径（必填，工作区内；v1 只校验不写）" },
      seed: { type: "integer", description: "可选；随机种子（非负整数，原样带给 comfyui 模板）" },
      overwrite: { type: "boolean", description: "可选；输出已存在时是否允许覆盖（缺省 false，v1 只校验）" },
    },
    output: {
      schema: RECEIPT_SCHEMA,
      render: renderSummary,
    },
    async execute(rawArgs, rawExec): Promise<VoiceReceipt> {
      const tool = "voice_design";
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const exec = rawExec as unknown as ToolExec; // DSH 运行时实传 ToolRunContext（类型面滞后），窄脸收口
      let ws: string;
      try {
        ws = resolveVoiceWorkspace(exec, host);
      } catch (e) {
        return errorReceipt(tool, e instanceof Error ? e.message : String(e));
      }
      const text = readStr(args, "text").trim();
      if (!text) return errorReceipt(tool, "text 必填（非空字符串）");
      const instruct = readStr(args, "instruct").trim();
      if (!instruct) return errorReceipt(tool, "instruct 必填（音色描述非空字符串）");
      const checked = checkOutputPath(args, ws, tool);
      if (isReceipt(checked)) return checked;
      if (args.seed !== undefined && (!Number.isInteger(args.seed) || (args.seed as number) < 0)) {
        return errorReceipt(tool, `seed 只收非负整数（收到 ${String(args.seed).slice(0, 40)}）`);
      }
      return {
        verdict: "experimental",
        summary: `${tool} [experimental] 参数校验通过（text ${text.length}字，instruct 已给），${DESIGN_GUIDANCE}`,
        details: {
          tool,
          stage: "validate-only",
          textChars: text.length,
          instruct,
          outputPath: checked.abs,
          ...(args.seed !== undefined ? { seed: args.seed as number } : {}),
          guidance: DESIGN_GUIDANCE,
        },
      };
    },
  });
}

// ---------- pronunciation_dict（读发音词典） ----------

/** 工作区自定义词典文件名（相对工作区根；不存在即只返回内置）。 */
export const CUSTOM_DICT_RELPATH = ".wwrs/pronunciation-dict.json";

export function makePronunciationDictTool(host?: VoiceToolsHost): unknown {
  return defineTool({
    name: "pronunciation_dict",
    description:
      "Read the pronunciation correction dictionary: built-in high-confidence entries merged with the optional workspace file .wwrs/pronunciation-dict.json (string array, extra entries deduped after built-ins). No parameters.",
    parameters: {},
    output: {
      schema: RECEIPT_SCHEMA,
      render: renderSummary,
    },
    async execute(rawArgs, rawExec): Promise<VoiceReceipt> {
      const tool = "pronunciation_dict";
      void rawArgs;
      const exec = rawExec as unknown as ToolExec; // DSH 运行时实传 ToolRunContext（类型面滞后），窄脸收口
      let ws: string;
      try {
        ws = resolveVoiceWorkspace(exec, host);
      } catch (e) {
        return errorReceipt(tool, e instanceof Error ? e.message : String(e));
      }
      const customAbs = resolve(ws, CUSTOM_DICT_RELPATH);
      let custom: string[] = [];
      let note = "";
      if (existsSync(customAbs)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(customAbs, "utf8"));
          if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
            note = `自定义词典形态非法（须为字符串数组，已忽略）：${customAbs}`;
          } else {
            custom = parsed.filter((e) => e.trim().length > 0);
          }
        } catch (e) {
          note = `自定义词典解析失败，已忽略：${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        }
      }
      const entries = [...new Set([...DEFAULT_PRONUNCIATION_DICT, ...custom])];
      const details: Record<string, JsonValue> = {
        entries,
        count: entries.length,
        builtIn: DEFAULT_PRONUNCIATION_DICT.length,
        custom: custom.length,
      };
      if (note) details.note = note;
      return okReceipt(`发音词典：内置 ${DEFAULT_PRONUNCIATION_DICT.length} 条 + 自定义 ${custom.length} 条，共 ${entries.length} 条`, details);
    },
  });
}

/** 注册面工厂（cordis apply 消费；tests 直调验合同形状与执行语义）。 */
export function createVoiceTools(host?: VoiceToolsHost): unknown[] {
  return [makeVoiceSynthesizeTool(host), makeVoiceCloneTool(host), makeVoiceDesignTool(host), makePronunciationDictTool(host)];
}
