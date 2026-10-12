import {
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  RecIndicator,
  SectionTitle,
  Spinner,
  Stat,
  StatusWarning,
  Toc,
  TocItem,
  Tooltip,
  TopBar,
} from "@endfield-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import { ENDPOINT_META } from "../../../../shared/endpoints.ts";
import type { BoardChannel, BoardResponse } from "../../../../shared/types.ts";
import { BrandMark } from "../../components/BrandMark";
import { RefreshIcon } from "../../components/icons";
import { ThemeToggle } from "../../components/ThemeToggle";
import { formatDateTime } from "../../lib/format";
import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  channelAnchor,
  computeBoardStats,
  formatClock,
  isBoardActive,
  relativeParts,
  tocEntries,
} from "./board-logic";
import { BoardSkeleton } from "./BoardSkeleton";
import { ModelCard } from "./ModelCard";
import { NowProvider, useNow } from "./now";
import { useBoard, type BoardFeed } from "./use-board";

/** 前台检测页（/）：所有启用的渠道、模型和它们最近的检测结果 */
export function BoardPage() {
  const feed = useBoard();
  const { data, error } = feed;
  const active = isBoardActive(data);
  const siteTitle = data?.site.title;

  useEffect(() => {
    if (!siteTitle) return;
    const previous = document.title;
    document.title = siteTitle;
    return () => {
      document.title = previous;
    };
  }, [siteTitle]);

  let content: ReactNode;
  if (data) {
    content = <BoardView board={data} />;
  } else if (error) {
    content = (
      <EmptyState
        className="mt-6"
        title="检测数据没能加载"
        description={
          <>
            {error.message}
            <span className="mt-1 block">页面会在后台自动重试。</span>
          </>
        }
        action={<RetryButton refresh={feed.refresh} />}
      />
    );
  } else {
    content = <BoardSkeleton />;
  }

  return (
    <NowProvider offset={feed.offset} fast={active}>
      <div className="flex min-h-dvh flex-col bg-surface text-ink">
        <TopBar
          brand={<BrandMark title={siteTitle} className="min-w-0" />}
          tools={
            <>
              <SyncStatus feed={feed} active={active} />
              <RefreshButton refresh={feed.refresh} />
              <ThemeToggle />
            </>
          }
        />
        <main className="mx-auto w-full max-w-[105rem] flex-1 px-4 pt-8 pb-16 sm:px-6 sm:pt-10 lg:px-8">
          {content}
        </main>
      </div>
    </NowProvider>
  );
}

function BoardView({ board }: { board: BoardResponse }) {
  const stats = computeBoardStats(board);
  const toc = tocEntries(board);

  return (
    <>
      <PageHeader
        meta="// IQ CHECK"
        title={board.site.title}
        description={board.site.description || undefined}
      >
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          <Stat label="检测渠道" value={stats.channels} unit="个" />
          <Stat label="检测模型" value={stats.models} unit="个" />
          <Stat label="检测题" value={stats.prompts} unit="道" />
          <LastCheckStat at={stats.lastCheckAt} />
        </div>
      </PageHeader>

      {board.channels.length === 0 ? (
        <EmptyState
          className="mt-12"
          title="还没有检测渠道"
          description="管理员配置好渠道和模型之后，各个模型的检测结果会显示在这里。"
        />
      ) : (
        <div className="mt-12 flex items-start gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-12">
            {board.channels.map((channel, index) => (
              <ChannelSection
                key={channel.id}
                channel={channel}
                index={index}
              />
            ))}
          </div>
          {/*
            很宽的屏幕才有这一列，窄一些时把宽度让给一行三张的模型卡；
            吸顶的顶栏高 56px，目录和各节的锚点都让出它
          */}
          <Toc
            title="// 本页"
            offset={80}
            className="sticky top-20 hidden max-h-[calc(100dvh-7rem)] w-48 shrink-0 overflow-y-auto 2xl:block"
          >
            {toc.map((entry) => (
              <TocItem key={entry.href} href={entry.href} level={entry.level}>
                {entry.label}
              </TocItem>
            ))}
          </Toc>
        </div>
      )}

      <footer className="mt-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-6 font-tech text-xs text-ink-tertiary">
        <p>
          {`// 每 ${POLL_IDLE_MS / 1000} 秒自动刷新，有检测进行时每 ${POLL_ACTIVE_MS / 1000} 秒刷新一次`}
        </p>
        <p className="tabular-nums">
          数据生成于 {formatDateTime(board.generatedAt)}
        </p>
      </footer>
    </>
  );
}

function ChannelSection({
  channel,
  index,
}: {
  channel: BoardChannel;
  index: number;
}) {
  const latin =
    ENDPOINT_META[channel.endpointType]?.short ?? channel.endpointType;
  const number = String(index + 1).padStart(2, "0");
  return (
    <section
      id={channelAnchor(channel.id)}
      className="flex min-w-0 scroll-mt-20 flex-col gap-5"
    >
      {/* 英文层写的是端点类型，不是渠道名的翻译，所以要让读屏读出来 */}
      <SectionTitle
        latin={latin}
        latinHidden={false}
        meta={`// 渠道 ${number}　${channel.models.length} 个模型`}
      >
        <span className="wrap-anywhere">{channel.name}</span>
      </SectionTitle>
      {channel.models.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={null}
          title="这个渠道还没有检测模型"
          description="管理员添加模型之后，检测结果会显示在这里。"
        />
      ) : (
        // 宽屏一行三张，平板两张，手机一张
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {channel.models.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 最近一次检测：拆成"数字 + 单位"放进统计块，悬停给出具体时间 */
function LastCheckStat({ at }: { at: string | null }) {
  const now = useNow();
  const { value, unit } = relativeParts(at, now);
  return (
    <Stat
      label="最近检测"
      value={value}
      unit={unit ?? undefined}
      title={at ? formatDateTime(at) : undefined}
    />
  );
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

function RetryButton({ refresh }: { refresh: () => Promise<void> }) {
  const [busy, run] = useBusy(refresh);
  return (
    <Button loading={busy} onClick={() => void run()}>
      重试
    </Button>
  );
}
