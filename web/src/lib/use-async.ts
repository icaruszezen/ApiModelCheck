import { useCallback, useEffect, useRef, useState } from "react";

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
 * 跑一个异步请求，拿到数据 / 错误 / 加载状态。deps 变化时重新请求，过期的响应会被丢掉。
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

  const reload = useCallback(async () => {
    const id = ++seq.current;
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
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback(
    (updater: (prev: T | undefined) => T | undefined) => setDataState(updater),
    [],
  );

  return { data, error, loading, reload, setData };
}
