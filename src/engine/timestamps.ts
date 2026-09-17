/** timestamps.ts —— 字幕 JSON → 词时间戳（防御性解析，不过度承诺）。
 *
 * 字幕下载地址由 T2A 回执给出，其 JSON 形态不由本包约定：
 * 本解析器接受数组直挂与 {words|subtitles|segments|units|data} 包裹，
 * 单项文本键取 text|word|content|char，起止取 startMs|start_ms|start|begin|
 * start_time 与 endMs|end_ms|end|finish|end_time。
 *
 * 单位口径（注释即契约，测试按此锁定）：`*_ms|start|end` 按毫秒；
 * `*_time` 按秒（×1000 取整）。认不出的载荷返回 []，由工具层
 * 带注记回执，不伪造精度。
 */

export type WordStamp = {
  text: string;
  startMs: number;
  endMs: number;
};

const TEXT_KEYS = ["text", "word", "content", "char"] as const;
const START_KEYS = ["startMs", "start_ms", "start", "begin", "start_time"] as const;
const END_KEYS = ["endMs", "end_ms", "end", "finish", "end_time"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function pickText(item: Record<string, unknown>): string {
  for (const k of TEXT_KEYS) {
    const v = item[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function pickNum(item: Record<string, unknown>, keys: readonly string[]): { value: number; seconds: boolean } | undefined {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      return { value: v, seconds: k.endsWith("_time") };
    }
  }
  return undefined;
}

function toMs(found: { value: number; seconds: boolean }): number {
  return found.seconds ? Math.round(found.value * 1000) : Math.round(found.value);
}

/** 字幕载荷 → 词时间戳（不可解析/空一律 []；起止缺任一即丢该项）。 */
export function parseWordStamps(payload: unknown): WordStamp[] {
  let list: unknown = payload;
  if (isRecord(payload)) {
    for (const k of ["words", "subtitles", "segments", "units", "data", "list"]) {
      if (Array.isArray(payload[k])) {
        list = payload[k];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return [];
  const out: WordStamp[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const start = pickNum(item, START_KEYS);
    const end = pickNum(item, END_KEYS);
    if (!start || !end) continue;
    const startMs = toMs(start);
    const endMs = toMs(end);
    if (endMs < startMs) continue;
    out.push({ text: pickText(item), startMs, endMs });
  }
  return out;
}
