import {
  Button,
  IconButton,
  RecIndicator,
  Spinner,
  StatusWarning,
  Tooltip,
  TopBar,
} from "@endfield-ui/react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { BrandMark } from "../../components/BrandMark";
import { RefreshIcon } from "../../components/icons";
import { ThemeToggle } from "../../components/ThemeToggle";
import { formatClock, isBoardActive } from "./board-logic";
import { NowProvider } from "./now";
import type { BoardFeed } from "./use-board";

export interface PublicShellProps {
  feed: BoardFeed;
  children: ReactNode;
}

/**
 * 前台各页的外壳：顶栏（站点标志、刷新状态、刷新、主题）和正文区。
 * 页面里的相对时间都从这里的时钟取
 */
export function PublicShell({ feed, children }: PublicShellProps) {
  const active = isBoardActive(feed.data);
  useScrollTopOnNavigate();
  return (
    <NowProvider offset={feed.offset} fast={active}>
      <div className="flex min-h-dvh flex-col bg-surface text-ink">
        <TopBar
          brand={
            <Link
              to="/"
              title="回到检测页"
              className="flex min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <BrandMark title={feed.data?.site.title} className="min-w-0" />
            </Link>
          }
          tools={
            <>
              <SyncStatus feed={feed} active={active} />
              <RefreshButton refresh={feed.refresh} />
              <ThemeToggle />
            </>
          }
        />
        <main className="mx-auto w-full max-w-[105rem] flex-1 px-4 pt-8 pb-16 sm:px-6 sm:pt-10 lg:px-8">
          {children}
        </main>
      </div>
    </NowProvider>
  );
}

/**
 * 点链接换到另一页时从顶上开始看，不停在上一页滚到的位置（浏览器的前进后退不管，各页自己恢复）。
 * 只看路径：详情页里换题、换哪一次只改查询参数，不跳；带锚点的交给页面自己滚到锚点
 */
function useScrollTopOnNavigate() {
  const { pathname, hash } = useLocation();
  const navigation = useNavigationType();
  useLayoutEffect(() => {
    if (navigation !== "POP" && !hash) window.scrollTo(0, 0);
    // 只在换页时跳一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
}

/** 页面打开期间把浏览器标签的标题换成 title；还没有标题时不动 */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** 顶栏上的刷新状态：失败时给一个不打扰的提示，有检测在进行时亮 LIVE，平时写更新时间 */
function SyncStatus({ feed, active }: { feed: BoardFeed; active: boolean }) {
  const failed = feed.data !== undefined && feed.error !== undefined;
  let visible: ReactNode = null;
  // 窄屏上顶栏要先让给站点标题：只有"刷新失败"在窄屏上也显示
  let wrapper = "hidden sm:inline-flex";
  if (failed) {
    wrapper = "inline-flex";
    visible = (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-warning"
        title={feed.error?.message}
      >
        <StatusWarning size={16} />
        <span>刷新失败</span>
        {feed.updatedAt !== null && (
          <span className="hidden font-tech text-ink-tertiary tabular-nums md:inline">
            · 显示的是 {formatClock(feed.updatedAt)} 的数据
          </span>
        )}
      </span>
    );
  } else if (active) {
    visible = <RecIndicator label="LIVE" />;
  } else if (feed.updatedAt !== null) {
    visible = (
      <span className="font-tech text-xs text-ink-tertiary tabular-nums">
        更新于 {formatClock(feed.updatedAt)}
      </span>
    );
  }
  return (
    <>
      {visible && (
        <span className={`${wrapper} mr-2 items-center`}>{visible}</span>
      )}
      {/* 常驻的播报区：只在刷新失败时有字，平时每次刷新都不出声 */}
      <span role="status" className="sr-only">
        {failed
          ? `刷新失败：${feed.error?.message ?? ""}，稍后会自动重试。`
          : ""}
      </span>
    </>
  );
}

function useBusy(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** 手动刷新。只有点了它才转圈，后台的定时刷新不惊动它 */
function RefreshButton({ refresh }: { refresh: () => Promise<void> }) {
  const [busy, run] = useBusy(refresh);
  return (
    <Tooltip content="立即刷新">
      <IconButton
        aria-label="立即刷新"
        aria-busy={busy || undefined}
        onClick={() => void run()}
      >
        {busy ? <Spinner label={null} /> : <RefreshIcon />}
      </IconButton>
    </Tooltip>
  );
}

export function RetryButton({ refresh }: { refresh: () => Promise<void> }) {
  const [busy, run] = useBusy(refresh);
  return (
    <Button loading={busy} onClick={() => void run()}>
      重试
    </Button>
  );
}
