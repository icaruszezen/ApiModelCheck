/**
 * 已登录的会话：外壳和设置页要显示账号名、提供"退出登录"。
 * 由 AdminApp 在登录后提供，外壳里的任何页面都能取到。
 */
import { createContext, useContext, useEffect } from "react";

export interface AdminSessionValue {
  username: string;
  /** 退出登录；失败时由它自己弹提示，不会抛出 */
  logout: () => Promise<void>;
  /** 正在退出（按钮显示加载中、防止连点） */
  loggingOut: boolean;
}

export const AdminSessionContext = createContext<AdminSessionValue | null>(
  null,
);

export function useAdminSession(): AdminSessionValue {
  const session = useContext(AdminSessionContext);
  if (!session) {
    throw new Error("useAdminSession 要在登录后的后台外壳里面用");
  }
  return session;
}

/** 设置浏览器标签上的标题，卸载时换回原来的 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
