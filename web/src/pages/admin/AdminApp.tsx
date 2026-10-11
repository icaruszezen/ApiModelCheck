/**
 * 后台入口（App.tsx 用 lazy() 引入，挂在 /admin/* 下）。
 * 先问服务器有没有登录：没有就显示登录页，登录后进外壳。登录页不换地址，
 * 所以登录成功后自然落在原先要去的那一页。任何后台接口返回 401 都会回到登录页。
 */
import { Button, EmptyState, Loader, useToast } from "@endfield-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import type { AdminSession } from "../../../../shared/types.ts";
import {
  adminApi,
  ApiRequestError,
  UNAUTHORIZED_EVENT,
} from "../../api/client";
import { AdminShell } from "./AdminShell";
import { ChannelsPage } from "./ChannelsPage";
import { LoginPage } from "./LoginPage";
import { ModelsPage } from "./ModelsPage";
import { PromptsPage } from "./PromptsPage";
import { ResultsPage } from "./ResultsPage";
import { SettingsPage } from "./SettingsPage";
import { DEFAULT_ADMIN_PATH } from "./shell-nav";
import { AdminSessionContext, type AdminSessionValue } from "./shell-session";
import { errorMessage } from "./ui";

type AuthState =
  | { status: "checking" }
  | { status: "anonymous"; notice?: string }
  | { status: "failed"; message: string }
  | { status: "ready"; session: AdminSession };

export default function AdminApp() {
  const toast = useToast();
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  // 加一次就重新检查一次登录状态（"重试"按钮）
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    adminApi.me().then(
      (session) => {
        if (!cancelled) setAuth({ status: "ready", session });
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
    // 登录接口密码错了也是 401、也会发这个事件：只在已登录时才当成"会话过期"
    const onUnauthorized = () =>
      setAuth((previous) =>
        previous.status === "ready"
          ? { status: "anonymous", notice: "登录已过期，请重新登录。" }
          : previous,
      );
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
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

  let content: ReactNode = null;
  if (auth.status === "anonymous") {
    content = (
      <LoginPage
        notice={auth.notice}
        onLoggedIn={(next) => setAuth({ status: "ready", session: next })}
      />
    );
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
  } else if (auth.status === "ready") {
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
      </AdminSessionContext>
    );
  }

  return (
    <>
      {content}
      {/* 和 App.tsx 里载入后台代码时的加载页是同一个样子：两段接起来像一次加载，确认完向上滑走 */}
      <Loader open={auth.status === "checking"} tagline="正在确认登录状态" />
    </>
  );
}
