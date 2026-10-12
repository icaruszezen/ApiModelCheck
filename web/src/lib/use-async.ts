import { useCallback, useEffect, useRef, useState } from "react";
import { isUnauthorized, REAUTHENTICATED_EVENT } from "../api/client";

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  /** 第一次加载、或者 reload 进行中 */
  loading: boolean;
  /** 重新请求；之前的数据在新数据到来之前保留 */
  reload: () => Promise<void>;
  /** 直接改本地数据（乐观更新） */
  setData: (updater: (prev: T | undefined) => T | undefined) => void;
}

/**
 * 重新登录之后要不要重新请求：上一次因为没登录（401）失败了，
 * 或者还有请求在路上（它可能是带着过期的凭据发出去的，回来也是 401）
 */
export function shouldReloadAfterReauth(state: {
  inFlight: boolean;
  error: unknown;
}): boolean {
  return state.inFlight || isUnauthorized(state.error);
}

/**
 * 在重新登录的弹窗里登录成功后调用 callback。enabled 为 false 时不监听
 */
export function useOnReauthenticated(
  callback: () => void,
  enabled = true,
): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const onReauthenticated = () => saved.current();
    window.addEventListener(REAUTHENTICATED_EVENT, onReauthenticated);
    return () =>
      window.removeEventListener(REAUTHENTICATED_EVENT, onReauthenticated);
  }, [enabled]);
}

/**
 * 跑一个异步请求，拿到数据 / 错误 / 加载状态。deps 变化时重新请求，过期的响应会被丢掉。
 * 会话过期、在弹窗里重新登录之后，因为 401 没载入的会自己重新请求，不用再点"重试"。
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  // 和 loading 一样，但同步更新：重新登录的事件处理里要立刻知道
  const inFlight = useRef(false);
  const errorRef = useRef(error);
  errorRef.current = error;

  const reload = useCallback(async () => {
    const id = ++seq.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (id !== seq.current) return;
      setDataState(next);
      setError(undefined);
    } catch (caught) {
      if (id !== seq.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (id === seq.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useOnReauthenticated(() => {
    if (
      shouldReloadAfterReauth({
        inFlight: inFlight.current,
        error: errorRef.current,
      })
    ) {
      void reload();
    }
  });

  const setData = useCallback(
    (updater: (prev: T | undefined) => T | undefined) => setDataState(updater),
    [],
  );

  return { data, error, loading, reload, setData };
}
