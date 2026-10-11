/**
 * 后台登录页和登录表单。账号密码来自服务器的环境变量，这里只负责提交和显示服务器的回答
 * （密码错误、尝试过多被限流、连不上服务器……）。
 * 表单单独导出：会话过期时 AdminApp 把它放进弹窗，盖在外壳上重新登录。
 */
import { Alert, Button, Field, Input } from "@endfield-ui/react";
import { useRef, useState, type RefObject, type SubmitEvent } from "react";
import { Link } from "react-router";
import type { AdminSession } from "../../../../shared/types.ts";
import { adminApi, ApiRequestError } from "../../api/client";
import { BrandMark } from "../../components/BrandMark";
import { ThemeToggle } from "../../components/ThemeToggle";
import { validateLogin } from "./login-form";
import { useDocumentTitle } from "./shell-session";
import { errorMessage } from "./ui";

export interface LoginFormProps {
  /** 预先填好的用户名（重新登录时用原来的账号）；给了就不自动聚焦用户名框 */
  initialUsername?: string;
  /** 密码框的引用，交给弹窗把初始焦点放上去；不传就用自己的 */
  passwordRef?: RefObject<HTMLInputElement | null>;
  onLoggedIn: (session: AdminSession) => void;
}

export function LoginForm({
  initialUsername,
  passwordRef: outerPasswordRef,
  onLoggedIn,
}: LoginFormProps) {
  const [username, setUsername] = useState(initialUsername ?? "");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const ownPasswordRef = useRef<HTMLInputElement>(null);
  const passwordRef = outerPasswordRef ?? ownPasswordRef;

  const { errors, input } = validateLogin(username, password);
  const shown = submitted ? errors : {};

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (!input) {
      (errors.username ? usernameRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const session = await adminApi.login(input);
      // 成功后登录页被外壳替换掉、弹窗关掉，按钮保持加载中直到消失，不再改自己的状态
      onLoggedIn(session);
    } catch (error) {
      setServerError(errorMessage(error));
      setBusy(false);
      // 密码不对：选中密码框，直接重打就能替换掉
      if (error instanceof ApiRequestError && error.status === 401) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
    }
  };

  return (
    <>
      {serverError && (
        <Alert tone="danger" title="登录失败" className="mb-6">
          {serverError}
        </Alert>
      )}
      <form
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        aria-label="登录后台"
      >
        <Field label="用户名" error={shown.username}>
          <Input
            ref={usernameRef}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={initialUsername === undefined}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="密码" error={shown.password}>
          <Input
            ref={passwordRef}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="action"
          block
          loading={busy}
          loadingText="正在登录"
          className="mt-1"
        >
          登录
        </Button>
      </form>
    </>
  );
}

export interface LoginPageProps {
  onLoggedIn: (session: AdminSession) => void;
}

/** 整页登录：只在一开始没登录、或者主动退出之后出现 */
export function LoginPage({ onLoggedIn }: LoginPageProps) {
  useDocumentTitle("登录 · 管理后台");

  return (
    <div className="flex min-h-dvh flex-col bg-surface text-ink">
      <header className="flex h-14 shrink-0 items-center justify-end px-4">
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-sm">
          <div className="border border-line bg-surface-raised p-6 shadow-sm sm:p-8">
            <BrandMark title="管理后台" />
            <h1 className="mt-6 text-2xl font-bold">登录</h1>
            <p className="mt-1 mb-6 text-sm text-ink-secondary">
              登录后才能配置渠道、模型和检测提示词。
            </p>

            <LoginForm onLoggedIn={onLoggedIn} />

            <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-ink-secondary">
              用户名和密码由服务器的环境变量{" "}
              <code className="font-mono text-ink">ADMIN_USERNAME</code> /{" "}
              <code className="font-mono text-ink">ADMIN_PASSWORD</code>{" "}
              设置。没设密码时，服务每次启动都会生成一个临时密码并打印在日志里。
            </p>
          </div>
          <p className="mt-4 text-center text-sm">
            <Link
              to="/"
              className="text-ink-secondary underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              返回检测页
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
