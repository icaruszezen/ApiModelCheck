import {
  EmptyState,
  PageHeader,
  SectionTitle,
  Stat,
  Toc,
  TocItem,
} from "@endfield-ui/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigationType } from "react-router";
import { ENDPOINT_META } from "../../../../shared/endpoints.ts";
import type { BoardChannel, BoardResponse } from "../../../../shared/types.ts";
import { formatDateTime } from "../../lib/format";
import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  channelAnchor,
  computeBoardStats,
  relativeParts,
  tocEntries,
} from "./board-logic";
import { BoardSkeleton } from "./BoardSkeleton";
import { ModelCard } from "./ModelCard";
import { useNow } from "./now";
import { PublicShell, RetryButton, useDocumentTitle } from "./PublicShell";
import { useBoard } from "./use-board";

/** 前台检测页（/）：所有启用的渠道、模型和它们最新一次的检测结果 */
export function BoardPage() {
  const feed = useBoard();
  const { data, error } = feed;
  useDocumentTitle(data?.site.title);
  useScrollPosition(data !== undefined);

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

  return <PublicShell feed={feed}>{content}</PublicShell>;
}

/** 离开首页时滚到的位置；用浏览器的后退回到首页时回到这里 */
let savedScroll = 0;

/**
 * 首页的滚动位置：从模型详情页后退回来时回到原来的位置；地址带着某张卡片的锚点
 * （详情页的返回按钮）时，数据一到就滚到那张卡片。数据还没到时页面只有骨架，滚不过去，等数据到了再滚
 */
function useScrollPosition(ready: boolean) {
  const { hash, key } = useLocation();
  const navigation = useNavigationType();
  const done = useRef<string | null>(null);

  useLayoutEffect(
    () => () => {
      savedScroll = window.scrollY;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!ready || done.current === key) return;
    done.current = key;
    if (hash) {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    } else if (navigation === "POP" && savedScroll > 0) {
      window.scrollTo(0, savedScroll);
    }
  }, [ready, hash, key, navigation]);
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
        // 宽屏一行三张，平板两张，手机一张。同一排拉成一样高（卡片底部那一行贴底对齐），
        // 回答再长也在卡片里限高滚动，一排不会被某一张撑得太高
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
