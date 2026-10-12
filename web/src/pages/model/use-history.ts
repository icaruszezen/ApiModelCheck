import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi } from "../../api/client";
import {
  HISTORY_PAGE_SIZE,
  appendPage,
  refreshLimit,
  type HistoryList,
} from "./model-logic";

export interface HistoryFeed {
  /** 已经拿到的记录；第一页还没到时是 null */
  list: HistoryList | null;
  /** 第一页没拿到时的错误；已经有列表时刷新失败不报，照旧显示 */
  error: string | null;
  loadingMore: boolean;
  /** "加载更多"失败时的错误 */
  moreError: string | null;
  loadMore: () => void;
  retry: () => void;
}

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "载入失败，请稍后重试。";
}

/**
 * 一条检测题的历史记录，新的在前。version（latestVersion）变了说明有新结果、或者检测刚结束，
 * 这时按已经加载的条数重新拉一遍、整个换掉（见 refreshLimit）
 */
export function useHistory(
  modelId: number,
  promptId: number,
  version: string | null,
): HistoryFeed {
  const [list, setList] = useState<HistoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 重新拉的时候要知道已经加载了多少条；放进依赖的话每次加载更多都会多拉一遍
  const loaded = useRef(0);
  useEffect(() => {
    loaded.current = list?.items.length ?? 0;
  }, [list]);
  // 卸载后晚到的"加载更多"不再落进来
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    publicApi
      .history(modelId, promptId, { limit: refreshLimit(loaded.current) })
      .then(
        (page) => {
          if (cancelled) return;
          setList({ items: page.items, hasMore: page.hasMore });
          setError(null);
        },
        (caught: unknown) => {
          if (!cancelled) setError(message(caught));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [modelId, promptId, version, attempt]);

  const oldest = list?.items.at(-1)?.id;
  const canLoadMore = list?.hasMore === true && oldest !== undefined;

  const loadMore = useCallback(() => {
    if (!canLoadMore || loadingMore || oldest === undefined) return;
    const before = oldest;
    setLoadingMore(true);
    setMoreError(null);
    publicApi
      .history(modelId, promptId, { limit: HISTORY_PAGE_SIZE, before })
      .then(
        (page) => {
          if (alive.current)
            setList((prev) => (prev ? appendPage(prev, page, before) : prev));
        },
        (caught: unknown) => {
          if (alive.current) setMoreError(message(caught));
        },
      )
      .finally(() => {
        if (alive.current) setLoadingMore(false);
      });
  }, [canLoadMore, loadingMore, modelId, promptId, oldest]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  return {
    list,
    error: list ? null : error,
    loadingMore,
    moreError,
    loadMore,
    retry,
  };
}
