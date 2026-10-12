/**
 * 已登录的会话：外壳和设置页要显示账号名、提供"退出登录"。
 * 由 AdminApp 在登录后提供，外壳里的任何页面都能取到。
 * 登录状态怎么随 401 变化也放在这里（纯函数，方便测）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { AdminSession } from "../../../../shared/types.ts";
import {
  isUnauthorized,
  type UnauthorizedEventDetail,
} from "../../api/client";
import { useOnReauthenticated } from "../../lib/use-async";
import { errorMessage } from "./error-text";

/** 后台的登录状态（AdminApp 用） */
export type AdminAuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "failed"; message: string }
  /** reauth：登录后某个接口回了 401（会话过期、服务重启换了密钥），要在外壳上盖重新登录的弹窗 */
  | { status: "ready"; session: AdminSession; reauth: boolean };

/**
 * 后台接口回了 401 之后的登录状态。只有已登录时才算"会话过期"：
 * 登录接口密码错了也是 401，确认登录状态的那次 401 由调用方自己处理。
 * 过期了也不卸下外壳（打开的抽屉、没保存的表单都留着），只把 reauth 打开；
 * 已经打开就原样返回，连着来几个 401 也只有一个弹窗
 */
export function sessionExpired(state: AdminAuthState): AdminAuthState {
  if (state.status !== "ready" || state.reauth) return state;
  return { ...state, reauth: true };
}

/** 没登录就关掉了重新登录的弹窗：外壳照旧，下一次 401 再弹出来 */
export function reauthDismissed(state: AdminAuthState): AdminAuthState {
  if (state.status !== "ready" || !state.reauth) return state;
  return { ...state, reauth: false };
}

/**
 * 这个 401 的请求是不是在最近一次登录之前就发出去了：那它带的是旧凭据，
 * 回 401 不说明现在的登录过期了，不用再弹窗。
 * 比如轮询在登录前刚发出、登录成功后才回来。lastLoginAt 和 detail.startedAt 都是 requestClock 的读数
 */
export function sentBeforeLogin(event: Event, lastLoginAt: number): boolean {
  const detail: Partial<UnauthorizedEventDetail> | undefined =
    event instanceof CustomEvent ? event.detail : undefined;
  return (
    typeof detail?.startedAt === "number" && detail.startedAt < lastLoginAt
  );
}

/** 表单上方"没能保存"那条提示的内容；unauthorized：是因为没登录（401）失败的 */
export interface SaveError {
  message: string;
  unauthorized: boolean;
}

export function toSaveError(error: unknown): SaveError {
  return { message: errorMessage(error), unauthorized: isUnauthorized(error) };
}

/**
 * 表单保存出错的提示。因为登录过期没保存上的，在弹窗里重新登录后自动收起：
 * 留着"未登录或登录已过期"会让人以为登录了也不行，再点一次保存就好
 */
export function useSaveError(): {
  /** 要显示的出错信息；null 表示不显示 */
  message: string | null;
  /** 保存失败时传入捕获到的错误 */
  fail: (error: unknown) => void;
  clear: () => void;
} {
  const [error, setError] = useState<SaveError | null>(null);
  useOnReauthenticated(() => setError(null), error?.unauthorized ?? false);
  const fail = useCallback(
    (caught: unknown) => setError(toSaveError(caught)),
    [],
  );
  const clear = useCallback(() => setError(null), []);
  return { message: error?.message ?? null, fail, clear };
}

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
