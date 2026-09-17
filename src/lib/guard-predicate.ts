/** voice-guard.ts —— 写保护守卫谓词真源（W1：产物落点判定）。
 *
 * 独立零依赖文件：守卫寄居主管线模块会随其加载失败静默消失，故谓词永不 import 业务模块。
 * 单调只拒不放：返回 string = 拒绝并说明理由，undefined = 通过。
 *
 * 判定口径（与 tools.ts resolveInsideWorkspace 同源）：本包四个工具的
 * outputPath/refAudio 参数必须落在注入工作区内；出界即拒。非本包工具一律放行。
 */

import { relative, resolve } from "node:path";

export type VoiceGuardExecution = { name: string; arguments: unknown };

/** 本包工具名（守卫只看这四件，别家工具一律放行）。 */
export const VOICE_TOOL_NAMES: readonly string[] = ["voice_synthesize", "voice_clone", "voice_design", "pronunciation_dict"];

/** W0 兼容壳：工作区未知时恒放行（execute 层仍逐调用强制归一工作区内）。 */
export function voiceGuardPredicate(_execution: VoiceGuardExecution): string | undefined {
  return undefined;
}

function argPath(args: unknown, keys: string[]): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function escapes(ws: string, rawPath: string): boolean {
  const abs = resolve(ws, rawPath);
  const rel = relative(ws, abs);
  return !rel || rel === ".." || rel.startsWith(`..${"/"}`);
}

/** 建工作区绑定的守卫谓词（cordis apply 消费；无工作区时用 voiceGuardPredicate 恒放行）。 */
export function createVoiceGuardPredicate(workspaceRoot: string): (execution: VoiceGuardExecution) => string | undefined {
  const ws = resolve(workspaceRoot);
  return (execution: VoiceGuardExecution) => {
    if (!execution || typeof execution.name !== "string") return undefined;
    if (!VOICE_TOOL_NAMES.includes(execution.name)) return undefined;
    for (const key of ["outputPath", "refAudio"]) {
      const p = argPath(execution.arguments, [key]);
      if (p && escapes(ws, p)) {
        return `[wwrs-voice 守卫] ${execution.name} 的 ${key} 出界（${p} 不在工作区 ${ws} 内），拒绝执行`;
      }
    }
    return undefined;
  };
}
