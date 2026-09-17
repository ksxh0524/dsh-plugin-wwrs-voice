/** workspace.ts —— 落点工作区解析（零依赖；只认三类注入面，不猜机器目录）。
 *
 * 优先级：config.workspace（profile patch 行，最高）> 环境变量 WWRS_WORKSPACE
 * > 自起点向上找中性锚 `.wwrs/workspace.json`。三类全 miss 即 fail-loud，
 * 报错直接给三条出路——绝不回落某个绝对路径、绝不静默降级。
 *
 * 本件只做路径定位：产物是否落在工作区内的判定在各工具 execute 与守卫谓词里做。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 环境变量注入位（缺省值，调用方可覆写 env 参数做测试隔离）。 */
export const WORKSPACE_ENV = "WWRS_WORKSPACE";
/** 中性锚文件（相对工作区根）：本插件唯一认的目录内标记。 */
export const WORKSPACE_ANCHOR_FILE = ".wwrs/workspace.json";

export type WorkspaceSource = "config" | "env" | "anchor";

export type WorkspaceResolution = {
  /** 解析出的工作区绝对路径。 */
  ws: string;
  /** 命中来源：config=patch 行 / env=环境变量 / anchor=锚文件向上找。 */
  source: WorkspaceSource;
  /** 锚查找试过的目录（报错时列给调用方）。 */
  tried: string[];
};

export type WorkspaceResolveOptions = {
  /** profile patch 行 config.workspace（最高优先级）。 */
  configWorkspace?: string;
  /** 环境变量表（缺省 process.env；测试传自有对象做隔离）。 */
  env?: Record<string, string | undefined>;
  /** 环境变量名（缺省 WWRS_WORKSPACE）。 */
  envVar?: string;
  /** 锚查找起点（缺省 process.cwd()）。 */
  cwd?: string;
  /** 锚文件相对路径（缺省 .wwrs/workspace.json）。 */
  anchorFile?: string;
};

function clean(p: unknown): string {
  return String(p ?? "").trim();
}

/** 该级目录是否放着合法锚文件（不存在/JSON 非法/非对象一律视为未命中，继续向上找）。 */
function anchorAt(dir: string, anchorFile: string): boolean {
  const file = join(dir, anchorFile);
  if (!existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return !!parsed && typeof parsed === "object";
  } catch {
    // 锚写坏 = 不认这一级（继续向上找），绝不静默认成别处
    return false;
  }
}

/** 自 start 向上逐级找锚文件（带试过的目录清单，供排障）。 */
export function findWorkspaceAnchor(start: string, anchorFile?: string): { ws: string; tried: string[] } | null {
  const anchor = clean(anchorFile) || WORKSPACE_ANCHOR_FILE;
  let cur = resolve(clean(start) || process.cwd());
  const tried: string[] = [];
  for (;;) {
    tried.push(cur);
    if (anchorAt(cur, anchor)) return { ws: cur, tried };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 解析工作区但不抛错（调用方要自己决定怎么报）：config > env > 锚，三类全 miss 返回 null。 */
export function tryResolveWorkspace(opts: WorkspaceResolveOptions = {}): WorkspaceResolution | null {
  const env = opts.env ?? process.env;
  const envVar = clean(opts.envVar) || WORKSPACE_ENV;
  const config = clean(opts.configWorkspace);
  if (config) return { ws: resolve(config), source: "config", tried: [] };
  const fromEnv = clean(env[envVar]);
  if (fromEnv) return { ws: resolve(fromEnv), source: "env", tried: [] };
  const anchorFile = clean(opts.anchorFile) || WORKSPACE_ANCHOR_FILE;
  const hit = findWorkspaceAnchor(clean(opts.cwd) || process.cwd(), anchorFile);
  return hit ? { ws: hit.ws, source: "anchor", tried: hit.tried } : null;
}

/** 工作区缺席时的可排错文案（三条出路；不猜路径）。 */
export function missingWorkspaceText(opts: { tried: string[]; envVar?: string; anchorFile?: string; cwd?: string }): string {
  const envVar = clean(opts.envVar) || WORKSPACE_ENV;
  const anchorFile = clean(opts.anchorFile) || WORKSPACE_ANCHOR_FILE;
  const tried = opts.tried.length ? opts.tried.slice(0, 6).join(" → ") : "（未试）";
  const more = opts.tried.length > 6 ? " …" : "";
  return [
    `[语音工作区未定位] 起点 ${clean(opts.cwd) || process.cwd()}；已向上找锚 ${opts.tried.length} 级：${tried}${more}`,
    `三条出路任选其一（本插件不探测任何外部工具链目录结构）：`,
    `  1) DSH profile patch 行给 config.workspace=<工作区绝对路径>（一实例一工作区，最稳）；`,
    `  2) 环境变量 ${envVar}=<工作区绝对路径>；`,
    `  3) 在工作区根放 ${anchorFile}，内容 {"kind":"<工作区种别>"}。`,
  ].join("\n");
}

/** 解析工作区，失败 fail-loud（带三条出路的可排错文案 + 已试目录清单）。 */
export function resolveWorkspace(opts: WorkspaceResolveOptions = {}): string {
  const hit = tryResolveWorkspace(opts);
  if (hit) return hit.ws;
  // 只在失败路径上再走一次锚查找，专为拿「试过哪些目录」——排障要看得见走过的路。
  const miss = findWorkspaceAnchor(clean(opts.cwd) || process.cwd(), clean(opts.anchorFile) || WORKSPACE_ANCHOR_FILE);
  throw new Error(
    missingWorkspaceText({
      tried: miss?.tried ?? [],
      cwd: clean(opts.cwd) || process.cwd(),
      envVar: opts.envVar,
      anchorFile: opts.anchorFile,
    }),
  );
}
