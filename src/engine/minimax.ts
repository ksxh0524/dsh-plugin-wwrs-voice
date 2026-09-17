/** minimax.ts —— MiniMax T2A 直调引擎（fetch 直调，不过队列、不经过 Comfy）。
 *
 * 移植意图（只读源的直调意图；业务名词零带入）：
 * 一段文本 → 音频字节 + 时长 + 字幕下载地址。并发/RPM/断点续传/产物编排
 * 一律不在本层——RPM 窗口由 lib/rate-limit.ts 在工具层卡，落盘由工具层做。
 *
 * 重试口径（与源一致）：429/5xx 进退避重试（缺省 2 次）；4xx 与
 * HTTP 200 + 业务码（base_resp.status_code !== 0）不重试；调用方取消
 * （Abort）永不重试。exec.signal 由工具层一路下钻到 fetch。
 *
 * 凭据只走 env（MINIMAX_API_KEY）：本层只收显式 apiKey 参数，
 * env 读取在工具层，缺失 fail-loud。
 */

export const T2A_ENDPOINT = "https://api.minimaxi.com/v1/t2a_v2";

/** MiniMax 凭据环境变量（唯一来源；工具层读取，缺失 fail-loud）。 */
export const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";

/** 文本硬上限（字符；源注释口径：SSE 在 3000 以上建议开流，10000 硬顶）。 */
export const MAX_TEXT_CHARS = 10000;
/** 长文本自动开流阈值（字符；源注释口径：官方建议 3000 以上走 SSE）。 */
export const STREAM_THRESHOLD_CHARS = 3000;

/** MiniMax HTTP 层错误（带状态码；队列/工具靠它区分可重试与确定性失败）。 */
export class MinimaxApiError extends Error {
  readonly status: number | undefined;
  readonly raw?: unknown;
  constructor(message: string, status: number | undefined, raw?: unknown) {
    super(message);
    this.name = "MinimaxApiError";
    this.status = status;
    if (raw !== undefined) this.raw = raw;
  }
}

/** 可重试状态码：429 与 5xx；4xx（含 400/401/403/404）一律不重试。 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status >= 500;
}

export type SynthesizeOptions = {
  apiKey: string;
  model: string;
  voiceId: string;
  speed?: number;
  emotion?: string;
  subtitleType?: string;
  endpoint?: string;
  textNormalization?: boolean;
  pronunciationDict?: string[];
  /** 缺省 text 长度>3000 自动开流；显式传值则按显式走。 */
  stream?: boolean;
  timeoutMs?: number;
  /** 失败重试次数（缺省 2；只对 429/5xx 与网络瞬断生效）。 */
  retries?: number;
  /** 调用方取消信号（工具 exec.signal 下钻；Abort 永不重试）。 */
  signal?: AbortSignal;
  /** 可注入（测试替身；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 可注入（测试不睡墙钟；缺省 setTimeout）。 */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type SynthesizeResult = {
  audio: Buffer;
  durationMs: number;
  subtitleUrl?: string;
  raw: unknown;
};

/** 内置高置信发音纠音词（源随包口径：只收口播高频多音字；调用方词典追加去重）。 */
export const DEFAULT_PRONUNCIATION_DICT: string[] = [
  "处理/(chu3)(li3)",
  "处置/(chu3)(zhi4)",
  "提供/(ti2)(gong1)",
  "应用/(ying4)(yong4)",
  "重来/(chong2)(lai2)",
  "重新/(chong2)(xin1)",
  "主角/(zhu3)(jue2)",
  "角色/(jue2)(se4)",
  "便宜/(pian2)(yi2)",
  "好奇/(hao4)(qi2)",
  "答复/(da2)(fu4)",
  "答应/(da1)(ying5)",
  "载人/(zai4)(ren2)",
  "晕车/(yun4)(che1)",
  "模型/(mo2)(xing2)",
  "芯片/(xin1)(pian4)",
  "下载/(xia4)(zai4)",
  "载入/(zai4)(ru4)",
  "载体/(zai4)(ti3)",
  "因为/(yin1)(wei4)",
  "处于/(chu3)(yu2)",
  "参与/(can1)(yu4)",
  "应对/(ying4)(dui4)",
  "供给/(gong1)(ji3)",
  "佣金/(yong4)(jin1)",
  "骨干/(gu3)(gan4)",
  "潜力/(qian2)(li4)",
  "重创/(zhong4)(chuang1)",
];

type JsonRecord = Record<string, unknown>;

function isRecord(v: unknown): v is JsonRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function strAt(record: JsonRecord, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function numAt(record: JsonRecord, key: string): number | undefined {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 组 T2A 请求体（源字段口径 1:1；发音词典=内置+显式，去重后注入）。 */
export function buildT2ARequestBody(
  text: string,
  options: Pick<SynthesizeOptions, "model" | "voiceId" | "speed" | "emotion" | "subtitleType" | "textNormalization" | "pronunciationDict" | "stream">,
): JsonRecord {
  const body: JsonRecord = {
    model: options.model,
    text,
    stream: options.stream ?? false,
    voice_setting: {
      voice_id: options.voiceId,
      speed: options.speed ?? 1,
      vol: 1,
      pitch: 0,
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    subtitle_enable: true,
    subtitle_type: options.subtitleType || "word",
    output_format: "hex",
    text_normalization: options.textNormalization ?? true,
  };
  if (options.emotion) (body.voice_setting as JsonRecord).emotion = options.emotion;
  const dict = [...DEFAULT_PRONUNCIATION_DICT, ...(options.pronunciationDict ?? [])];
  const deduped = [...new Set(dict)];
  if (deduped.length) body.pronunciation_dict = { tone: deduped };
  return body;
}

/** 合并 SSE 流事件（`data: <json>` 行；status=1 中间块 / status=2 或 is_final 末块）。 */
export function mergeStreamPayload(text: string): JsonRecord {
  const merged: JsonRecord = { data: {} };
  const data = merged.data as JsonRecord;
  let sawFinal = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const eventData = event.data;
    if (isRecord(eventData)) {
      if (typeof eventData.audio === "string") data.audio = String(data.audio ?? "") + eventData.audio;
      if (typeof eventData.subtitle_file === "string") data.subtitle_file = eventData.subtitle_file;
      if (eventData.is_final === true) sawFinal = true;
    }
    if (isRecord(event.extra_info)) {
      merged.extra_info = event.extra_info;
      if (typeof event.extra_info.audio_length === "number" && event.extra_info.audio_length > 0) sawFinal = true;
    }
    if (isRecord(event.base_resp)) {
      merged.base_resp = event.base_resp;
      if (event.base_resp.status === 2) sawFinal = true;
    }
    if (typeof event.trace_id === "string") merged.trace_id = event.trace_id;
  }
  // 末块信号（is_final / status=2 / audio_length>0）缺席即判截断：
  // HTTP 200 只证明连接正常，证明不了音频收齐——无末事件一律不交付残音频。
  // （源口径只卡 status_code===0 且无末事件；此处收紧：无末事件即拒。）
  if (!sawFinal) {
    throw new Error("MiniMax SSE stream ended without a final event; audio is likely truncated");
  }
  return merged;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 退避时长（500ms 起指数退避，8s 封顶；确定性可测）。 */
export function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("synthesis aborted by caller");
    err.name = "AbortError";
    throw err;
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** 单次 T2A 请求（不重试；重试由 synthesizeBlock 的循环做）。 */
async function postOnce(text: string, options: SynthesizeOptions, endpoint: string, stream: boolean, signal: AbortSignal): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = buildT2ARequestBody(text, { ...options, stream });
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // 调用方取消直通（永不重试）；其余网络瞬断包装成无状态码错误由上层判重试。
    if (isAbortError(e)) throw e;
    throw new MinimaxApiError(`MiniMax request failed: ${e instanceof Error ? e.message : String(e)}`, undefined, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (!response.ok) {
    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, 300);
    } catch {
      snippet = "(unreadable body)";
    }
    throw new MinimaxApiError(`MiniMax HTTP ${response.status}: ${snippet}`, response.status);
  }
  const payload: unknown = stream ? mergeStreamPayload(await response.text()) : await response.json();
  if (!isRecord(payload)) throw new Error("MiniMax returned a non-object payload");
  const baseResp = payload.base_resp;
  const code = isRecord(baseResp) ? baseResp.status_code : undefined;
  if (code !== 0) {
    // 业务码路径：源无权威语义表，不臆断瞬态——一律不重试。
    const msg = isRecord(baseResp) && typeof baseResp.status_msg === "string" ? baseResp.status_msg : "unknown";
    const trace = typeof payload.trace_id === "string" ? payload.trace_id : "-";
    throw new Error(`MiniMax error ${String(code)}: ${msg} (trace ${trace})`);
  }
  return payload;
}

/**
 * 合成一段文本。返回音频字节、时长毫秒与字幕下载地址（若有）。
 * 429/5xx/网络瞬断退避重试（缺省 2 次）；4xx/业务码/取消不重试。
 */
export async function synthesizeBlock(text: string, options: SynthesizeOptions): Promise<SynthesizeResult> {
  const endpoint = options.endpoint || T2A_ENDPOINT;
  const stream = options.stream ?? text.length > STREAM_THRESHOLD_CHARS;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const retries = options.retries ?? 2;
  const sleep = options.sleepImpl ?? defaultSleep;
  // 超时与调用方取消合并：任一触发即停；取消错误永不重试。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(options.signal);
    try {
      const payload = await postOnce(text, options, endpoint, stream, signal);
      const data = isRecord(payload.data) ? payload.data : {};
      const hex = data.audio;
      if (typeof hex !== "string" || !hex) throw new Error("MiniMax returned no audio payload");
      const extra = isRecord(payload.extra_info) ? payload.extra_info : {};
      const result: SynthesizeResult = {
        audio: Buffer.from(hex, "hex"),
        durationMs: numAt(extra, "audio_length") ?? 0,
        raw: payload,
      };
      const subtitleUrl = strAt(data, "subtitle_file");
      if (subtitleUrl) result.subtitleUrl = subtitleUrl;
      return result;
    } catch (e) {
      lastError = e;
      if (isAbortError(e)) throw e;
      throwIfAborted(options.signal);
      // 无状态码的网络瞬断可重试；有状态码只 429/5xx 可重试；业务码裸 Error 不重试。
      const retryable = e instanceof MinimaxApiError ? (e.status === undefined ? true : isRetryableStatus(e.status)) : false;
      if (!retryable || attempt >= retries) throw e;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 下载合成字幕 JSON（词时间戳来源；失败即抛，由工具层转成空戳+注记，不整体失败）。 */
export async function fetchSubtitleJson(url: string, opts: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 20000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (e) {
    throw new Error(`subtitle download failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) throw new Error(`subtitle download failed: HTTP ${response.status} for ${url}`);
  try {
    return (await response.json()) as unknown;
  } catch (e) {
    throw new Error(`subtitle download returned non-JSON for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
