/**
 * 后台的栏目表：侧轨、全屏菜单、页面标题共用同一份。
 * 图标在 AdminShell 里按 key 对上（这里不引组件，方便在 node 环境里测试）。
 */

export type AdminSection =
  | "models"
  | "channels"
  | "prompts"
  | "results"
  | "settings";

export interface AdminSectionInfo {
  key: AdminSection;
  label: string;
  path: string;
}

export const ADMIN_BASE = "/admin";

export const ADMIN_SECTIONS: readonly AdminSectionInfo[] = [
  { key: "models", label: "模型", path: "/admin/models" },
  { key: "channels", label: "渠道", path: "/admin/channels" },
  { key: "prompts", label: "提示词", path: "/admin/prompts" },
  { key: "results", label: "检测记录", path: "/admin/results" },
  { key: "settings", label: "设置", path: "/admin/settings" },
];

/** 进后台默认落在哪一栏 */
export const DEFAULT_ADMIN_PATH = "/admin/models";

/**
 * 从地址里认出当前栏目：/admin/prompts、/admin/prompts/、/admin/prompts/12 都算"提示词"。
 * 不分大小写，和路由的匹配规则一致。认不出时返回 null。
 */
export function sectionFromPath(pathname: string): AdminSection | null {
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments[0] !== "admin") return null;
  const key = segments[1];
  return ADMIN_SECTIONS.find((section) => section.key === key)?.key ?? null;
}

export function sectionLabel(section: AdminSection): string {
  return ADMIN_SECTIONS.find((item) => item.key === section)?.label ?? "";
}

/** 浏览器标签上的标题："渠道 · 管理后台" */
export function adminDocumentTitle(section: AdminSection | null): string {
  return section ? `${sectionLabel(section)} · 管理后台` : "管理后台";
}
