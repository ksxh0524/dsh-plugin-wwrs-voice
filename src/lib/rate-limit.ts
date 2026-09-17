/** rate-limit.ts —— 滑动窗 RPM 限流（零依赖；纯内存，进程级）。
 *
 * 初始配额取自老分档数字（移植源 provider policy 实证）：
 * 合成 10 次/分、复刻 60 次/分、设计 20 次/分——全部走配置可覆写，
 * 不写死：调用方经 createVoiceRateLimiter 传 overrides 整体替换某档。
 *
 * 语义：tryAcquire 判准入（窗内记账）；超限返回 ok:false + retryAfterMs，
 * 由工具层转成模型可见的错误收据（客户端侧 429，不进提供商重试）。
 * 时间源可注入（now 参数），测试不睡墙钟。
 */

export type VoiceOperation = "synthesize" | "clone" | "design";

export type RateQuota = {
  /** 窗内最多放行次数（≥1）。 */
  maxCalls: number;
  /** 窗长毫秒（>0）。 */
  windowMs: number;
};

/** 老分档初始配额（T2A 10 RPM / 复刻 60/分 / 设计 20/分；调用方配置可覆写）。 */
export const DEFAULT_VOICE_QUOTAS: Record<VoiceOperation, RateQuota> = {
  synthesize: { maxCalls: 10, windowMs: 60_000 },
  clone: { maxCalls: 60, windowMs: 60_000 },
  design: { maxCalls: 20, windowMs: 60_000 },
};

export type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

function normalizeQuota(op: VoiceOperation, q: RateQuota): RateQuota {
  const maxCalls = Number.isInteger(q.maxCalls) && q.maxCalls >= 1 ? q.maxCalls : DEFAULT_VOICE_QUOTAS[op].maxCalls;
  const windowMs = Number.isFinite(q.windowMs) && q.windowMs > 0 ? q.windowMs : DEFAULT_VOICE_QUOTAS[op].windowMs;
  return { maxCalls, windowMs };
}

/** 滑动窗限流器（key=操作档；stamp 记放行时刻，窗外过期自动丢弃）。 */
export class VoiceRateLimiter {
  private readonly quotas: Record<VoiceOperation, RateQuota>;
  private readonly stamps = new Map<VoiceOperation, number[]>();

  constructor(overrides?: Partial<Record<VoiceOperation, RateQuota>>) {
    this.quotas = {
      synthesize: normalizeQuota("synthesize", { ...DEFAULT_VOICE_QUOTAS.synthesize, ...overrides?.synthesize }),
      clone: normalizeQuota("clone", { ...DEFAULT_VOICE_QUOTAS.clone, ...overrides?.clone }),
      design: normalizeQuota("design", { ...DEFAULT_VOICE_QUOTAS.design, ...overrides?.design }),
    };
  }

  quotaOf(op: VoiceOperation): RateQuota {
    return { ...this.quotas[op] };
  }

  /** 判准入：窗内未满即记账放行；满了返回最早过期的等待毫秒（≥1）。 */
  tryAcquire(op: VoiceOperation, now: number = Date.now()): AcquireResult {
    const q = this.quotas[op];
    const fresh = (this.stamps.get(op) ?? []).filter((t) => now - t < q.windowMs);
    if (fresh.length < q.maxCalls) {
      fresh.push(now);
      this.stamps.set(op, fresh);
      return { ok: true };
    }
    const oldest = Math.min(...fresh);
    this.stamps.set(op, fresh);
    return { ok: false, retryAfterMs: Math.max(1, oldest + q.windowMs - now) };
  }

  /** 清空记账（测试隔离；生产路径不调）。 */
  reset(): void {
    this.stamps.clear();
  }
}

/** 缺省进程级实例（工具层无显式配置时用它；配了 quotas 即自建实例）。 */
export const defaultVoiceLimiter = new VoiceRateLimiter();

export function createVoiceRateLimiter(overrides?: Partial<Record<VoiceOperation, RateQuota>>): VoiceRateLimiter {
  return new VoiceRateLimiter(overrides);
}
