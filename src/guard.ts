/** guard.ts —— dsh-plugin-wwrs-voice 写保护守卫注册薄壳（W1：工作区绑定谓词）。
 *
 * 真源在 ./lib/guard-predicate.ts（独立零依赖，见其头注）；本文件只做 ctx.tools.guard 挂载。
 * 注意：DSH Service 方法依赖 this，裸传会丢绑定——包一层闭包保绑定。
 */
import { createVoiceGuardPredicate, voiceGuardPredicate } from "./lib/guard-predicate.ts";
import type { GuardFn, HostContext } from "./lib/host.ts";

export function registerVoiceGuard(ctx: HostContext, opts?: { workspace?: string }): () => void {
  const rawGuard = ctx.tools?.guard;
  if (typeof rawGuard !== "function") return () => {};
  // 工作区已知即绑落点判定；未知退回恒放行（execute 层仍逐调用归一工作区内，不留写出界窗口）。
  const ws = typeof opts?.workspace === "string" && opts.workspace.trim() ? opts.workspace.trim() : "";
  const fn: GuardFn = ws ? createVoiceGuardPredicate(ws) : voiceGuardPredicate;
  return rawGuard.call(ctx.tools, fn);
}
