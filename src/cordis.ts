/** cordis.ts —— dsh-plugin-wwrs-voice 挂载适配层（W1 工具落地；官方插件形：default={name,inject,apply} 对象）。
 *
 * 注册面：voice_synthesize（MiniMax T2A 全实现）/ voice_clone（v1 校验+指引，experimental）/
 * voice_design（v1 校验+指引，experimental）/ pronunciation_dict（读发音词典）
 * → ctx.tools.register；写保护守卫 → ctx.tools.guard（谓词真源见 lib/guard-predicate.ts，
 * 工作区已知即绑落点判定，未知退回恒放行——execute 层仍逐调用归一工作区内）。
 * 行名与包名对齐（dsh-plugin-wwrs-voice）；改名必同步 package.json 与 cordis.patch.yml。
 */

import { createVoiceTools } from "./tools.ts";
import { registerVoiceGuard } from "./guard.ts";
import type { HostContext, ToolRecord } from "./lib/host.ts";

export const name = "dsh-plugin-wwrs-voice";
export const inject: string[] = ["tools"];

export type CordisConfig = {
  /** 工作区根（profile patch 行 config.workspace=<绝对路径>；缺省 env WWRS_WORKSPACE，再缺省中性锚探测）。 */
  workspace?: string;
};

export function apply(ctx: HostContext, config?: CordisConfig) {
  for (const tool of createVoiceTools(config?.workspace ? { workspace: config.workspace } : {})) {
    ctx.tools?.register(tool as ToolRecord);
  }
  const unregister = registerVoiceGuard(ctx, config?.workspace ? { workspace: config.workspace } : {});
  ctx.logger?.info?.(
    `[dsh-plugin-wwrs-voice] voice_synthesize + voice_clone + voice_design + pronunciation_dict on（workspace=${config?.workspace ?? "(env WWRS_WORKSPACE/中性锚探测)"} guard=${typeof unregister === "function" ? "on" : "no-hook"}）`,
  );
  return { unregister };
}

export default { name, inject, apply };
