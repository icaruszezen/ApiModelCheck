/**
 * 模型页和检测记录页共用的几个小 hook：定时刷新、跟着走的"现在"、屏幕宽度。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * 每隔 delay 毫秒调用一次 callback（上一次结束后才开始计时，请求慢时不会叠在一起）。
 * delay 为 null 时停止。页面隐藏时跳过，回到页面时立刻补一次。
 */
export function usePolling(
  callback: () => unknown,
  delay: number | null,
): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delay === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      if (document.visibilityState === "hidden") {
        missed = true;
        schedule();
        return;
      }
      try {
        await saved.current();
      } catch {
        // 出错由调用方自己记录和展示，这里只负责继续下一轮
      }
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !missed) return;
      missed = false;
      clearTimeout(timer);
      void tick();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [delay]);
}

/** 当前时间戳，每隔 intervalMs 更新一次：相对时间、已进行时长跟着走 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 媒体查询现在是否成立，跟着窗口变化；没有 matchMedia 的环境当作不成立 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
    () => false,
  );
}
