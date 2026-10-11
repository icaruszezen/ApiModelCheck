/**
 * 后台入口（App.tsx 用 lazy() 引入，挂在 /admin/* 下）。
 * 先问服务器有没有登录：没有就显示登录页，登录后进外壳。登录页不换地址，
 * 所以登录成功后自然落在原先要去的那一页。
 * 登录后某个后台接口返回 401（会话过期、服务重启）时不卸下外壳，而是在上面弹出重新登录的弹窗：
 * 打开的抽屉和没保存的内容都还在，登录后再点一次保存就行；因为 401 没载入的列表会自己重新载入。
 */
import { Button, Dialog, EmptyState, useToast } from "@endfield-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import type { AdminSession } from "../../../../shared/types.ts";
import {
  adminApi,
  ApiRequestError,
  REAUTHENTICATED_EVENT,
  requestClock,
  UNAUTHORIZED_EVENT,
} from "../../api/client";
import { AdminLoading } from "../../components/AdminLoading";
import { AdminShell } from "./AdminShell";
import { ChannelsPage } from "./ChannelsPage";
import { LoginForm, LoginPage } from "./LoginPage";
import { ModelsPage } from "./ModelsPage";
import { PromptsPage } from "./PromptsPage";
import { ResultsPage } from "./ResultsPage";
import { SettingsPage } from "./SettingsPage";
import { DEFAULT_ADMIN_PATH } from "./shell-nav";
import {
  AdminSessionContext,
  reauthDismissed,
  sentBeforeLogin,
  sessionExpired,
  type AdminAuthState,
  type AdminSessionValue,
} from "./shell-session";
import { errorMessage } from "./ui";

export default function AdminApp() {
  const toast = useToast();
  const [auth, setAuth] = useState<AdminAuthState>({ status: "checking" });
  // 加一次就重新检查一次登录状态（"重试"按钮）
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const reauthPasswordRef = useRef<HTMLInputElement>(null);
  // 最近一次登录成功的时刻（requestClock 的读数）：在这之前发出的请求回 401 不算过期
  const lastLoginAt = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    let cancelled = false;
    adminApi.me().then(
      (session) => {
        if (!cancelled) setAuth({ status: "ready", session, reauth: false });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setAuth({ status: "anonymous" });
        } else {
          setAuth({ status: "failed", message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    // 登录接口密码错了也是 401、也会发这个事件：sessionExpired 只在已登录时才当成"会话过期"。
    // 登录前就发出去的请求（比如轮询）登录后才回 401：带的是旧凭据，不再弹窗
    const onUnauthorized = (event: Event) => {
      if (sentBeforeLogin(event, lastLoginAt.current)) return;
      setAuth(sessionExpired);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const loggedIn = useCallback((session: AdminSession) => {
    lastLoginAt.current = requestClock();
    setAuth({ status: "ready", session, reauth: false });
    // 在弹窗里重新登录的：让因为 401 没载入的列表、表单上的提示自己刷新（登录页登录时还没有页面在听）
    window.dispatchEvent(new Event(REAUTHENTICATED_EVENT));
  }, []);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await adminApi.logout();
      setAuth({ status: "anonymous" });
    } catch (error) {
      toast({
        message: `退出登录失败：${errorMessage(error)}`,
        tone: "danger",
      });
    } finally {
      setLoggingOut(false);
    }
  }, [toast]);

  const username = auth.status === "ready" ? auth.session.username : "";
  const session = useMemo<AdminSessionValue>(
    () => ({ username, logout, loggingOut }),
    [username, logout, loggingOut],
  );

  let content: ReactNode;
  if (auth.status === "checking") {
    // 确认登录状态通常只要几十毫秒，提示过 300ms 还没好才淡入；
    // 和 App.tsx 载入后台代码时是同一个组件，那边已经显示出来时这里接着显示，不会闪一下
    content = <AdminLoading />;
  } else if (auth.status === "anonymous") {
    content = <LoginPage onLoggedIn={loggedIn} />;
  } else if (auth.status === "failed") {
    content = (
      <main className="flex min-h-dvh items-center justify-center bg-surface p-4 text-ink">
        <EmptyState
          className="w-full max-w-xl"
          title="后台暂时打不开"
          description={`没能确认登录状态：${auth.message}`}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button
                onClick={() => {
                  setAuth({ status: "checking" });
                  setAttempt((value) => value + 1);
                }}
              >
                重试
              </Button>
              <Button variant="light" render={<Link to="/" />}>
                回到检测页
              </Button>
            </div>
          }
        />
      </main>
    );
  } else {
    content = (
      <AdminSessionContext value={session}>
        <AdminShell>
          <Routes>
            <Route
              index
              element={<Navigate to={DEFAULT_ADMIN_PATH} replace />}
            />
            <Route path="models" element={<ModelsPage />} />
            <Route path="channels" element={<ChannelsPage />} />
            <Route path="prompts" element={<PromptsPage />} />
            <Route path="results" element={<ResultsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={<Navigate to={DEFAULT_ADMIN_PATH} replace />}
            />
          </Routes>
        </AdminShell>
        {/*
          会话过期：盖在外壳上重新登录，下面的页面和抽屉不动。
          可以关掉（比如先把没保存的内容复制出来），下一次请求再回 401 时会再弹出来
        */}
        <Dialog
          alert
          size="sm"
          open={auth.reauth}
          onOpenChange={(open) => {
            if (!open) setAuth(reauthDismissed);
          }}
          title="登录已过期"
          description="重新登录后接着操作就行，打开的编辑窗口和没保存的内容都还在。"
          initialFocus={reauthPasswordRef}
        >
          <LoginForm
            initialUsername={auth.session.username}
            passwordRef={reauthPasswordRef}
            onLoggedIn={loggedIn}
          />
        </Dialog>
      </AdminSessionContext>
    );
  }

  return content;
}
