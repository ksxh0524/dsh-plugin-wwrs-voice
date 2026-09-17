/** host.ts —— 宿主上下文最小结构类型（W1：工具注册 + 执行上下文窄面）。
 *
 * 只声明本包实际触达的面（tools 注册 + logger），不复述宿主全量类型；
 * 服务端零依赖铁律：此处不得 import 任何宿主协议包（dsh-tools 的
 * defineTool 例外：工具 DSL，按 ADR-007 合法；且此处只引类型）。
 */
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

export type ToolRecord = {
  name: string;
  [key: string]: unknown;
};

export type GuardFn = (execution: { name: string; arguments: unknown }) => string | undefined;

export type HostContext = {
  tools?: {
    register: (tool: ToolRecord) => unknown;
    guard?: (fn: GuardFn) => () => void;
  };
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

/** 工具 execute 的 exec 窄面（ToolRunContext 的插件用面：取消信号 + 会话 cwd + 过程播报）。 */
export type ToolExec = ToolRunContext & {
  agent?: {
    session?: { meta?: { cwd?: string }; header?: { cwd?: string } };
    options?: { provider?: string; model?: string };
  };
  /** 过程播报（官方 onUpdate 同位）。 */
  onProgress?(update: { content: Array<{ type: string; text: string }> }): void;
  signal?: AbortSignal;
};
