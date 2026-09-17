/** voice.test.ts —— W1 工具落地回归：校验/限流/重试判定/错误载荷全覆盖。
 *
 * 真链路（MiniMax T2A）缺 key 即 skip，只跑替身；不断言任何外部状态。
 * 时间源/限流记账/工作区全部走注入或临时目录，测试间零共享可变状态
 * （进程级 defaultVoiceLimiter 除外——涉它的用例串行并首尾 reset）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backoffMs,
  DEFAULT_PRONUNCIATION_DICT,
  fetchSubtitleJson,
  isRetryableStatus,
  mergeStreamPayload,
  MinimaxApiError,
  synthesizeBlock,
} from "../src/engine/minimax.ts";
import { parseWordStamps } from "../src/engine/timestamps.ts";
import { createVoiceRateLimiter, DEFAULT_VOICE_QUOTAS, defaultVoiceLimiter } from "../src/lib/rate-limit.ts";
import { createVoiceGuardPredicate, VOICE_TOOL_NAMES, voiceGuardPredicate } from "../src/lib/guard-predicate.ts";
import { registerVoiceGuard } from "../src/guard.ts";
import {
  createVoiceTools,
  makeVoiceCloneTool,
  makeVoiceDesignTool,
  makeVoiceSynthesizeTool,
  makePronunciationDictTool,
  resolveInsideWorkspace,
  resolveVoiceWorkspace,
  type VoiceToolsHost,
} from "../src/tools.ts";

// ---------- 小件 ----------

type Receipt = { verdict: string; summary: string; details: Record<string, unknown> };

type CallableTool = {
  name: string;
  description: string;
  output: { render: (a: unknown, v: unknown) => Array<{ type: string; text: string }> };
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
};

function asCallable(t: unknown): CallableTool {
  return t as unknown as CallableTool;
}

function asReceipt(v: unknown): Receipt {
  return v as unknown as Receipt;
}

/** 建隔离工作区（含中性锚），返回绝对路径。 */
function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), "wwrs-voice-"));
  mkdirSync(join(ws, ".wwrs"), { recursive: true });
  writeFileSync(join(ws, ".wwrs", "workspace.json"), JSON.stringify({ kind: "voice-test" }));
  return ws;
}

function execFor(ws: string, extra: Record<string, unknown> = {}): unknown {
  return { agent: { session: { meta: { cwd: ws } } }, ...extra };
}

type StubStep = { status: number; body: unknown };

/** 按脚本依次应答的 fetch 替身；log 收请求体（JSON 串）。 */
function stubFetch(log: string[], script: StubStep[]): typeof fetch {
  let i = 0;
  const fn = async (_url: unknown, init?: unknown): Promise<Response> => {
    const step = script[Math.min(i++, script.length - 1)] as StubStep;
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body === "string") log.push(body);
    const text = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    return new Response(text, { status: step.status, headers: { "Content-Type": "application/json" } });
  };
  return fn as typeof fetch;
}

const AUDIO_HEX = Buffer.from("fake-audio-bytes").toString("hex");

function t2aOk(extra: Record<string, unknown> = {}): StubStep {
  return {
    status: 200,
    body: {
      base_resp: { status_code: 0, status_msg: "success" },
      data: { audio: AUDIO_HEX, subtitle_file: "https://example.invalid/sub.json" },
      extra_info: { audio_length: 1234 },
      trace_id: "trace-1",
      ...extra,
    },
  };
}

function synthHost(ws: string, log: string[], script: StubStep[], extraHost: Partial<VoiceToolsHost> = {}): VoiceToolsHost {
  return { workspace: ws, env: { MINIMAX_API_KEY: "test-key" }, fetchImpl: stubFetch(log, script), ...extraHost };
}

// ---------- 工作区解析 ----------

test("工作区：config > env > 锚，三级优先级", async () => {
  const ws = makeWs();
  const sub = join(ws, "a", "b");
  mkdirSync(sub, { recursive: true });
  const anchor = (await import("../src/lib/workspace.ts")).tryResolveWorkspace;
  assert.equal(anchor({ configWorkspace: "/cfg", env: { WWRS_WORKSPACE: ws }, cwd: sub })?.ws, "/cfg");
  assert.equal(anchor({ configWorkspace: " ", env: { WWRS_WORKSPACE: ws }, cwd: sub })?.source, "env");
  assert.equal(anchor({ env: {}, cwd: sub })?.ws, ws);
  assert.equal(anchor({ env: {}, cwd: sub })?.source, "anchor");
});

test("工作区：三类全 miss 即 fail-loud，三条出路齐", async () => {
  const { resolveWorkspace } = await import("../src/lib/workspace.ts");
  const probe = mkdtempSync(join(tmpdir(), "wwrs-noanchor-"));
  assert.throws(() => resolveWorkspace({ env: {}, cwd: probe }), /config\.workspace/);
  assert.throws(() => resolveWorkspace({ env: {}, cwd: probe }), /WWRS_WORKSPACE/);
  assert.throws(() => resolveWorkspace({ env: {}, cwd: probe }), /\.wwrs\/workspace\.json/);
});

test("工作区：写坏的锚跳过不认（继续向上找，不静默认领）", async () => {
  const { findWorkspaceAnchor } = await import("../src/lib/workspace.ts");
  const ws = makeWs();
  const bad = join(ws, "bad");
  mkdirSync(join(bad, ".wwrs"), { recursive: true });
  writeFileSync(join(bad, ".wwrs", "workspace.json"), "{oops");
  assert.equal(findWorkspaceAnchor(bad)?.ws, ws);
});

test("resolveVoiceWorkspace：config 直返；否则走会话 cwd 锚", () => {
  const ws = makeWs();
  assert.equal(resolveVoiceWorkspace(execFor("/elsewhere") as never, { workspace: ws }), ws);
  assert.equal(resolveVoiceWorkspace(execFor(join(ws, "sub")) as never, { env: {} }), ws);
});

test("resolveInsideWorkspace：出界抛错（含绝对路径出界）", () => {
  const ws = makeWs();
  assert.throws(() => resolveInsideWorkspace(ws, "../escape.mp3", "outputPath"), /须落在工作区内/);
  assert.throws(() => resolveInsideWorkspace(ws, "/tmp/outside.mp3", "outputPath"), /须落在工作区内/);
  assert.ok(resolveInsideWorkspace(ws, "a/b.mp3", "outputPath").startsWith(ws));
});

// ---------- 限流 ----------

test("限流：初始配额=老分档数字（合成10/复刻60/设计20，窗60s）", () => {
  assert.deepEqual(DEFAULT_VOICE_QUOTAS.synthesize, { maxCalls: 10, windowMs: 60_000 });
  assert.deepEqual(DEFAULT_VOICE_QUOTAS.clone, { maxCalls: 60, windowMs: 60_000 });
  assert.deepEqual(DEFAULT_VOICE_QUOTAS.design, { maxCalls: 20, windowMs: 60_000 });
});

test("限流：窗内放满即拒并给 retryAfterMs，窗滑过即放", () => {
  const limiter = createVoiceRateLimiter({ synthesize: { maxCalls: 2, windowMs: 1000 } });
  assert.equal(limiter.tryAcquire("synthesize", 0).ok, true);
  assert.equal(limiter.tryAcquire("synthesize", 10).ok, true);
  const blocked = limiter.tryAcquire("synthesize", 20);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.retryAfterMs, 980);
  assert.equal(limiter.tryAcquire("synthesize", 1000).ok, true);
});

test("限流：非法覆写回落缺省；reset 清空记账", () => {
  const limiter = createVoiceRateLimiter({ synthesize: { maxCalls: 0, windowMs: -5 } });
  assert.deepEqual(limiter.quotaOf("synthesize"), DEFAULT_VOICE_QUOTAS.synthesize);
  const tiny = createVoiceRateLimiter({ design: { maxCalls: 1, windowMs: 60_000 } });
  assert.equal(tiny.tryAcquire("design", 0).ok, true);
  assert.equal(tiny.tryAcquire("design", 1).ok, false);
  tiny.reset();
  assert.equal(tiny.tryAcquire("design", 1).ok, true);
});

// ---------- 引擎：成功与请求体 ----------

test("引擎：成功路径回音频字节+时长+字幕地址", async () => {
  const log: string[] = [];
  const out = await synthesizeBlock("你好", {
    apiKey: "k",
    model: "m",
    voiceId: "v",
    fetchImpl: stubFetch(log, [t2aOk()]),
    sleepImpl: async () => {},
  });
  assert.equal(out.audio.toString(), "fake-audio-bytes");
  assert.equal(out.durationMs, 1234);
  assert.equal(out.subtitleUrl, "https://example.invalid/sub.json");
  assert.equal(log.length, 1);
});

test("引擎：请求体口径（音色/语速/情感/词典自动注入/hex 输出）", async () => {
  const log: string[] = [];
  await synthesizeBlock("处理模型", {
    apiKey: "k",
    model: "speech-02-hd",
    voiceId: "vv",
    speed: 1.2,
    emotion: "happy",
    pronunciationDict: ["重来/(chong2)(lai2)", "自定/(zi4)(ding4)"],
    fetchImpl: stubFetch(log, [t2aOk()]),
    sleepImpl: async () => {},
  });
  const body = JSON.parse(log[0] as string) as Record<string, unknown>;
  const vs = body.voice_setting as Record<string, unknown>;
  assert.equal(vs.voice_id, "vv");
  assert.equal(vs.speed, 1.2);
  assert.equal(vs.emotion, "happy");
  assert.equal((body.audio_setting as Record<string, unknown>).format, "mp3");
  assert.equal(body.output_format, "hex");
  const tone = (body.pronunciation_dict as { tone: string[] }).tone;
  assert.ok(tone.includes("处理/(chu3)(li3)"));
  assert.ok(tone.includes("自定/(zi4)(ding4)"));
  assert.equal(tone.filter((e) => e === "重来/(chong2)(lai2)").length, 1);
});

test("引擎：长文本自动开流并合并 SSE（短文本不走流）", async () => {
  const log: string[] = [];
  const part1 = Buffer.from("AB").toString("hex");
  const part2 = Buffer.from("CD").toString("hex");
  const sse = [
    `data: ${JSON.stringify({ data: { audio: part1 }, base_resp: { status: 1 } })}`,
    `data: ${JSON.stringify({ data: { audio: part2, subtitle_file: "https://example.invalid/s.json" }, extra_info: { audio_length: 500 }, base_resp: { status: 2, status_code: 0 } })}`,
  ].join("\n");
  const out = await synthesizeBlock("x".repeat(3001), {
    apiKey: "k",
    model: "m",
    voiceId: "v",
    fetchImpl: stubFetch(log, [{ status: 200, body: sse }]),
    sleepImpl: async () => {},
  });
  assert.equal(out.audio.toString(), "ABCD");
  assert.equal(out.durationMs, 500);
  assert.equal(JSON.parse(log[0] as string).stream, true);
  const log2: string[] = [];
  await synthesizeBlock("短", {
    apiKey: "k",
    model: "m",
    voiceId: "v",
    fetchImpl: stubFetch(log2, [t2aOk()]),
    sleepImpl: async () => {},
  });
  assert.equal(JSON.parse(log2[0] as string).stream, false);
});

test("引擎：SSE 无末事件即判截断（不交付残音频）", () => {
  const bad = `data: ${JSON.stringify({ data: { audio: "ab" }, base_resp: { status: 1 } })}`;
  assert.throws(() => mergeStreamPayload(bad), /without a final event/);
});

// ---------- 引擎：重试判定 ----------

test("重试判定口径：429/5xx 可重试，4xx/业务码/无音频不重试", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(undefined), false);
  assert.deepEqual([backoffMs(0), backoffMs(1), backoffMs(2), backoffMs(99)], [500, 1000, 2000, 8000]);
});

test("引擎：429 后成功（重试1次，退避被调用）", async () => {
  const log: string[] = [];
  const sleeps: number[] = [];
  const out = await synthesizeBlock("hi", {
    apiKey: "k",
    model: "m",
    voiceId: "v",
    fetchImpl: stubFetch(log, [{ status: 429, body: "slow down" }, t2aOk()]),
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(out.audio.toString(), "fake-audio-bytes");
  assert.equal(log.length, 2);
  assert.deepEqual(sleeps, [500]);
});

test("引擎：5xx 连败耗尽重试后抛 MinimaxApiError（带状态码载荷）", async () => {
  const log: string[] = [];
  await assert.rejects(
    () =>
      synthesizeBlock("hi", {
        apiKey: "k",
        model: "m",
        voiceId: "v",
        retries: 2,
        fetchImpl: stubFetch(log, [
          { status: 500, body: "boom" },
          { status: 503, body: "boom" },
          { status: 500, body: "boom" },
        ]),
        sleepImpl: async () => {},
      }),
    (e: unknown) => e instanceof MinimaxApiError && e.status === 500 && String(e.message).includes("MiniMax HTTP 500"),
  );
  assert.equal(log.length, 3);
});

test("引擎：400 只打一次（不重试，状态码进载荷）", async () => {
  const log: string[] = [];
  await assert.rejects(
    () =>
      synthesizeBlock("hi", {
        apiKey: "k",
        model: "m",
        voiceId: "v",
        fetchImpl: stubFetch(log, [{ status: 400, body: "bad request" }]),
        sleepImpl: async () => {},
      }),
    (e: unknown) => e instanceof MinimaxApiError && e.status === 400,
  );
  assert.equal(log.length, 1);
});

test("引擎：业务码（200+status_code!=0）裸 Error 不重试", async () => {
  const log: string[] = [];
  await assert.rejects(
    () =>
      synthesizeBlock("hi", {
        apiKey: "k",
        model: "m",
        voiceId: "v",
        fetchImpl: stubFetch(log, [{ status: 200, body: { base_resp: { status_code: 17, status_msg: "quota out" }, trace_id: "t-9" } }]),
        sleepImpl: async () => {},
      }),
    (e: unknown) => e instanceof Error && !(e instanceof MinimaxApiError) && /MiniMax error 17/.test(e.message),
  );
  assert.equal(log.length, 1);
});

test("引擎：200 无音频载荷即抛（不重试）", async () => {
  const log: string[] = [];
  await assert.rejects(
    () =>
      synthesizeBlock("hi", {
        apiKey: "k",
        model: "m",
        voiceId: "v",
        fetchImpl: stubFetch(log, [{ status: 200, body: { base_resp: { status_code: 0 }, data: {} } }]),
        sleepImpl: async () => {},
      }),
    /no audio payload/,
  );
  assert.equal(log.length, 1);
});

test("引擎：调用方取消永不重试（Abort 直通）", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      synthesizeBlock("hi", {
        apiKey: "k",
        model: "m",
        voiceId: "v",
        signal: controller.signal,
        fetchImpl: stubFetch(log, [t2aOk()]),
        sleepImpl: async () => {},
      }),
    (e: unknown) => e instanceof Error && e.name === "AbortError",
  );
  assert.equal(log.length, 0);
});

test("引擎：网络瞬断可重试（无状态码 MinimaxApiError）", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(t2aOk().body), { status: 200 });
  }) as typeof fetch;
  const out = await synthesizeBlock("hi", { apiKey: "k", model: "m", voiceId: "v", fetchImpl: flaky, sleepImpl: async () => {} });
  assert.equal(out.audio.toString(), "fake-audio-bytes");
  assert.equal(calls, 2);
});

test("fetchSubtitleJson：非 200/非 JSON 均抛错", async () => {
  await assert.rejects(() => fetchSubtitleJson("https://example.invalid/a", { fetchImpl: stubFetch([], [{ status: 500, body: "x" }]) }), /HTTP 500/);
  await assert.rejects(() => fetchSubtitleJson("https://example.invalid/a", { fetchImpl: stubFetch([], [{ status: 200, body: "not-json{{{" }]) }), /non-JSON/);
  const ok = await fetchSubtitleJson("https://example.invalid/a", {
    fetchImpl: stubFetch([], [{ status: 200, body: { words: [] } }]),
  });
  assert.deepEqual(ok, { words: [] });
});

// ---------- 词时间戳解析 ----------

test("parseWordStamps：数组直挂/ms 键/秒键换算/残项丢弃", () => {
  assert.deepEqual(parseWordStamps([{ text: "你", startMs: 0, endMs: 200 }]), [{ text: "你", startMs: 0, endMs: 200 }]);
  assert.deepEqual(parseWordStamps({ words: [{ word: "好", start_time: 0.2, end_time: 0.5 }] }), [{ text: "好", startMs: 200, endMs: 500 }]);
  assert.deepEqual(parseWordStamps({ subtitles: [{ content: "啊", start: 100, end: 50 }] }), []);
  assert.deepEqual(parseWordStamps({ data: [{ text: "缺", startMs: 10 }] }), []);
  assert.deepEqual(parseWordStamps({ nope: 1 }), []);
  assert.deepEqual(parseWordStamps("str"), []);
});

// ---------- 工具面：注册形状 ----------

test("工具面：4 工具齐名且全带 output.render（缺 render boot 期即炸）", () => {
  const tools = createVoiceTools({}).map(asCallable);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["voice_synthesize", "voice_clone", "voice_design", "pronunciation_dict"],
  );
  for (const t of tools) {
    const blocks = t.output.render({}, { verdict: "ok", summary: "摘要", details: {} });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text, "摘要");
  }
  assert.ok(asCallable(makeVoiceCloneTool({})).description.includes("experimental"));
  assert.ok(asCallable(makeVoiceDesignTool({})).description.includes("experimental"));
});

// ---------- voice_synthesize 参数校验 ----------

test("synthesize：空 text/缺 voiceId/缺 model/非法 speed/空 emotion 全拒", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceSynthesizeTool(synthHost(ws, [], [t2aOk()])));
  const base = { text: "你好", voiceId: "v", model: "m", outputPath: "a.mp3" };
  for (const args of [
    { ...base, text: "  " },
    { ...base, voiceId: " " },
    { ...base, model: "" },
    { ...base, speed: 3 },
    { ...base, emotion: " " },
    { ...base, outputPath: "" },
    { ...base, outputPath: "../escape.mp3" },
    { ...base, outputPath: "a.wav" },
  ]) {
    const r = asReceipt(await tool.execute(args, execFor(ws)));
    assert.equal(r.verdict, "error", JSON.stringify(args));
  }
  // 类型错在 schema 层即拦（ToolDefinition.execute 直调同样先生效，不进 execute 体）。
  await assert.rejects(tool.execute({ ...base, speed: "快" }, execFor(ws)), /must be a number/);
});

test("synthesize：text 超 10000 字拒（带计数载荷）", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceSynthesizeTool(synthHost(ws, [], [t2aOk()])));
  const r = asReceipt(await tool.execute({ text: "字".repeat(10001), voiceId: "v", model: "m", outputPath: "a.mp3" }, execFor(ws)));
  assert.equal(r.verdict, "error");
  assert.equal(r.details.maxChars, 10000);
  assert.equal(r.details.chars, 10001);
});

test("synthesize：缺 MINIMAX_API_KEY 即 fail-loud（点名 env）", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceSynthesizeTool({ workspace: ws, env: {} }));
  const r = asReceipt(await tool.execute({ text: "你好", voiceId: "v", model: "m", outputPath: "a.mp3" }, execFor(ws)));
  assert.equal(r.verdict, "error");
  assert.match(r.details.error as string, /MINIMAX_API_KEY/);
});

test("synthesize：输出已存在且非 overwrite 即拒；overwrite=true 放行", async () => {
  const ws = makeWs();
  const log: string[] = [];
  const host = synthHost(ws, log, [t2aOk(), t2aOk()]);
  const tool = asCallable(makeVoiceSynthesizeTool(host));
  const args = { text: "你好", voiceId: "v", model: "m", outputPath: "a.mp3" };
  writeFileSync(join(ws, "a.mp3"), "old");
  const denied = asReceipt(await tool.execute(args, execFor(ws)));
  assert.equal(denied.verdict, "error");
  assert.match(denied.details.error as string, /overwrite/);
  assert.equal(log.length, 0);
  const ok = asReceipt(await tool.execute({ ...args, overwrite: true }, execFor(ws)));
  assert.equal(ok.verdict, "ok");
});

test("synthesize：成功落盘 mp3（无字幕地址→空戳+注记）", async () => {
  const ws = makeWs();
  const log: string[] = [];
  const step = t2aOk();
  (step.body as Record<string, unknown>).data = { audio: AUDIO_HEX };
  (step.body as Record<string, unknown>).extra_info = { audio_length: 777 };
  const tool = asCallable(makeVoiceSynthesizeTool(synthHost(ws, log, [step])));
  const r = asReceipt(await tool.execute({ text: "你好世界", voiceId: "v", model: "m", outputPath: "sub/dir/a.mp3" }, execFor(ws)));
  assert.equal(r.verdict, "ok");
  assert.equal(r.details.chars, 4);
  assert.equal(r.details.durationMs, 777);
  assert.deepEqual(r.details.timestamps, []);
  assert.ok(typeof r.details.timestampNote === "string");
  const abs = r.details.audioPath as string;
  assert.equal(readFileSync(abs).toString(), "fake-audio-bytes");
});

test("synthesize：字幕下载成功即带词戳；失败则空戳+注记不整体失败", async () => {
  const ws = makeWs();
  const subs = { words: [{ text: "你", startMs: 0, endMs: 200 }] };
  const fetchBoth = (async (url: unknown) => {
    if (String(url).includes("minimaxi")) return new Response(JSON.stringify(t2aOk().body), { status: 200 });
    return new Response(JSON.stringify(subs), { status: 200 });
  }) as typeof fetch;
  const tool = asCallable(makeVoiceSynthesizeTool({ workspace: ws, env: { MINIMAX_API_KEY: "k" }, fetchImpl: fetchBoth }));
  const ok = asReceipt(await tool.execute({ text: "你", voiceId: "v", model: "m", outputPath: "a.mp3" }, execFor(ws)));
  assert.equal(ok.verdict, "ok");
  assert.deepEqual(ok.details.timestamps, [{ text: "你", startMs: 0, endMs: 200 }]);

  const fetchBadSub = (async (url: unknown) => {
    if (String(url).includes("minimaxi")) return new Response(JSON.stringify(t2aOk().body), { status: 200 });
    return new Response("oops", { status: 500 });
  }) as typeof fetch;
  const tool2 = asCallable(makeVoiceSynthesizeTool({ workspace: ws, env: { MINIMAX_API_KEY: "k" }, fetchImpl: fetchBadSub }));
  const ok2 = asReceipt(await tool2.execute({ text: "你", voiceId: "v", model: "m", outputPath: "b.mp3" }, execFor(ws)));
  assert.equal(ok2.verdict, "ok");
  assert.deepEqual(ok2.details.timestamps, []);
  assert.ok(typeof ok2.details.timestampNote === "string");
});

test("synthesize：引擎 4xx 转错误收据（状态码进 details）", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceSynthesizeTool(synthHost(ws, [], [{ status: 401, body: "bad key" }])));
  const r = asReceipt(await tool.execute({ text: "你好", voiceId: "v", model: "m", outputPath: "a.mp3" }, execFor(ws)));
  assert.equal(r.verdict, "error");
  assert.equal(r.details.status, 401);
});

test("synthesize：RPM 窗满转错误收据（带 retryAfterMs，不进提供商重试）", async () => {
  const ws = makeWs();
  const log: string[] = [];
  const host = synthHost(ws, log, [t2aOk(), t2aOk()], { quotas: { synthesize: { maxCalls: 1, windowMs: 60_000 } } });
  const tool = asCallable(makeVoiceSynthesizeTool(host));
  const args = { text: "你好", voiceId: "v", model: "m", outputPath: "n.mp3" };
  assert.equal(asReceipt(await tool.execute(args, execFor(ws))).verdict, "ok");
  const limited = asReceipt(await tool.execute({ ...args, outputPath: "n2.mp3" }, execFor(ws)));
  assert.equal(limited.verdict, "error");
  assert.ok(typeof limited.details.retryAfterMs === "number" && (limited.details.retryAfterMs as number) > 0);
  assert.equal(log.length, 1);
});

// ---------- voice_clone / voice_design ----------

test("clone：缺 text/缺 refAudio/引用不存在/出界/坏 seed 全拒", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceCloneTool({ workspace: ws }));
  const ref = join(ws, "ref.mp3");
  writeFileSync(ref, "x");
  for (const args of [
    { text: "", refAudio: "ref.mp3", outputPath: "o.mp3" },
    { text: "hi", refAudio: "", outputPath: "o.mp3" },
    { text: "hi", refAudio: "missing.mp3", outputPath: "o.mp3" },
    { text: "hi", refAudio: "../escape.mp3", outputPath: "o.mp3" },
    { text: "hi", refAudio: "ref.mp3", outputPath: "../o.mp3" },
    { text: "hi", refAudio: "ref.mp3", outputPath: "o.mp3", seed: -1 },
  ]) {
    const r = asReceipt(await tool.execute(args, execFor(ws)));
    assert.equal(r.verdict, "error", JSON.stringify(args));
  }
});

test("clone：校验通过即 experimental 指引（点名 comfyui，不写文件）", async () => {
  const ws = makeWs();
  writeFileSync(join(ws, "ref.mp3"), "x");
  const tool = asCallable(makeVoiceCloneTool({ workspace: ws }));
  const r = asReceipt(await tool.execute({ text: "你好", refAudio: "ref.mp3", outputPath: "out/clone.mp3", seed: 7 }, execFor(ws)));
  assert.equal(r.verdict, "experimental");
  assert.equal(r.details.stage, "validate-only");
  assert.match(r.summary, /dsh-plugin-wwrs-comfyui/);
  assert.equal(r.details.seed, 7);
});

test("design：缺 instruct 即拒；通过即 experimental 指引", async () => {
  const ws = makeWs();
  const tool = asCallable(makeVoiceDesignTool({ workspace: ws }));
  const bad = asReceipt(await tool.execute({ text: "你好", instruct: " ", outputPath: "o.mp3" }, execFor(ws)));
  assert.equal(bad.verdict, "error");
  const r = asReceipt(await tool.execute({ text: "你好", instruct: "年轻女声", outputPath: "o.mp3" }, execFor(ws)));
  assert.equal(r.verdict, "experimental");
  assert.equal(r.details.stage, "validate-only");
  assert.match(r.summary, /dsh-plugin-wwrs-comfyui/);
  assert.equal(r.details.instruct, "年轻女声");
});

// ---------- pronunciation_dict ----------

test("pronunciation_dict：内置非空 + 工作区自定义合并去重", async () => {
  const ws = makeWs();
  const tool = asCallable(makePronunciationDictTool({ workspace: ws }));
  const base = asReceipt(await tool.execute({}, execFor(ws)));
  assert.equal(base.verdict, "ok");
  assert.ok((base.details.count as number) >= DEFAULT_PRONUNCIATION_DICT.length);
  assert.ok((base.details.entries as string[]).includes("处理/(chu3)(li3)"));

  writeFileSync(join(ws, ".wwrs", "pronunciation-dict.json"), JSON.stringify(["处理/(chu3)(li3)", "自定/(zi4)(ding4)"]));
  const merged = asReceipt(await tool.execute({}, execFor(ws)));
  assert.equal(merged.details.custom, 2);
  assert.equal(merged.details.count, DEFAULT_PRONUNCIATION_DICT.length + 1);
  assert.ok((merged.details.entries as string[]).includes("自定/(zi4)(ding4)"));
});

test("pronunciation_dict：非法自定义文件不炸（注记+内置照返）", async () => {
  const ws = makeWs();
  writeFileSync(join(ws, ".wwrs", "pronunciation-dict.json"), JSON.stringify({ not: "array" }));
  const tool = asCallable(makePronunciationDictTool({ workspace: ws }));
  const r = asReceipt(await tool.execute({}, execFor(ws)));
  assert.equal(r.verdict, "ok");
  assert.equal(r.details.custom, 0);
  assert.ok(typeof r.details.note === "string");
});

// ---------- 守卫 ----------

test("守卫：本包工具出界拒、界内放；别家工具一律放", () => {
  const ws = makeWs();
  const guard = createVoiceGuardPredicate(ws);
  assert.match(String(guard({ name: "voice_synthesize", arguments: { outputPath: "../x.mp3" } })), /出界/);
  assert.match(String(guard({ name: "voice_clone", arguments: { refAudio: "/tmp/r.mp3" } })), /出界/);
  assert.equal(guard({ name: "voice_synthesize", arguments: { outputPath: "a.mp3" } }), undefined);
  assert.equal(guard({ name: "bash", arguments: { command: "rm -rf /" } }), undefined);
  assert.equal(voiceGuardPredicate({ name: "voice_synthesize", arguments: { outputPath: "../x.mp3" } }), undefined);
  assert.ok(VOICE_TOOL_NAMES.includes("pronunciation_dict"));
});

test("守卫注册：经 ctx.tools.guard 挂载并返回卸载函数", () => {
  let seen: unknown;
  const ctx = { tools: { register: () => {}, guard: (fn: unknown) => ((seen = fn), () => {}) } };
  const unregister = registerVoiceGuard(ctx as never, { workspace: makeWs() });
  assert.equal(typeof unregister, "function");
  assert.equal(typeof seen, "function");
  const noHook = registerVoiceGuard({ tools: { register: () => {} } } as never);
  assert.equal(typeof noHook, "function");
});

// ---------- 真链路（缺 key 即 skip） ----------

test(
  "live 真链路合成（需 MINIMAX_API_KEY + VOICE_LIVE_VOICE_ID + VOICE_LIVE_MODEL）",
  {
    skip: !process.env.MINIMAX_API_KEY || !process.env.VOICE_LIVE_VOICE_ID || !process.env.VOICE_LIVE_MODEL,
  },
  async () => {
    const out = await synthesizeBlock("语音插件真链路探测", {
      apiKey: process.env.MINIMAX_API_KEY as string,
      model: process.env.VOICE_LIVE_MODEL as string,
      voiceId: process.env.VOICE_LIVE_VOICE_ID as string,
      retries: 0,
    });
    assert.ok(out.audio.length > 0);
  },
);

// 别动进程级默认限流器的脏状态（真链路/上游用例若触达，此处复位）。
test("收尾：默认限流器复位", () => {
  defaultVoiceLimiter.reset();
});
