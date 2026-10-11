import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardResponse } from "../../../../shared/types.ts";
import { publicApi } from "../../api/client";
import { clockOffset, nextPollDelay } from "./board-logic";

export interface BoardFeed {
  /** 最近一次成功拿到的数据；刷新失败时保留旧的 */
  data: BoardResponse | undefined;
  /** 最近一次请求的错误；下一次成功后清掉 */
  error: Error | undefined;
  /** 连续失败的次数 */
  failures: number;
  /** 最近一次成功的时间（浏览器时钟） */
  updatedAt: number | null;
  /** 服务器时钟比浏览器快多少毫秒 */
  offset: number;
  /** 立刻刷新一次；已经有请求在路上时等它，不重复发 */
  refresh: () => Promise<void>;
}

interface FeedState {
  data: BoardResponse | undefined;
  error: Error | undefined;
  failures: number;
  updatedAt: number | null;
  offset: number;
}

const INITIAL: FeedState = {
  data: undefined,
  error: undefined,
  failures: 0,
  updatedAt: null,
  offset: 0,
};

/**
 * 定时拉取前台看板。平时 30 秒一次，有检测在进行时 3 秒一次，
 * 快到某个模型的下次检测时间时在到点后不久拉一次；页面被切到后台时停下，切回来立刻刷新一次。连续失败时退避。
 */
export function useBoard(): BoardFeed {
  const [state, setState] = useState<FeedState>(INITIAL);
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    // 轮询的状态全部放在这次 effect 的闭包里：StrictMode 下挂载两次也是两个互不相干的轮询器，
    // 前一个被清理后它的响应直接丢掉
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: Promise<void> | null = null;
    let lastData: BoardResponse | undefined;
    let lastOffset = 0;
    let failures = 0;

    const hidden = () => document.visibilityState === "hidden";

    const schedule = () => {
      clearTimeout(timer);
      if (disposed || hidden()) return;
      timer = setTimeout(
        () => void load(),
        nextPollDelay(lastData, failures, Date.now() + lastOffset),
      );
    };

    const load = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (inflight) return inflight;
      clearTimeout(timer);
      inflight = (async () => {
        try {
          const data = await publicApi.board();
          if (disposed) return;
          const receivedAt = Date.now();
          lastData = data;
          lastOffset = clockOffset(data.generatedAt, receivedAt);
          failures = 0;
          setState({
            data,
            error: undefined,
            failures: 0,
            updatedAt: receivedAt,
            offset: lastOffset,
          });
        } catch (caught) {
          if (disposed) return;
          failures += 1;
          const error =
            caught instanceof Error ? caught : new Error(String(caught));
          const count = failures;
          setState((prev) => ({ ...prev, error, failures: count }));
        } finally {
          inflight = null;
          schedule();
        }
      })();
      return inflight;
    };

    const onVisibility = () => {
      if (hidden()) clearTimeout(timer);
      else void load();
    };
    // 断网恢复时不用等到下一拍
    const onOnline = () => void load();

    refreshRef.current = load;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    void load();

    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);

  return { ...state, refresh };
}
