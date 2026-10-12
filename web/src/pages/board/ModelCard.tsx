import {
  Panel,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tag,
  TagPair,
} from "@endfield-ui/react";
import { useState, type ReactNode } from "react";
import type { BoardCheck, BoardModel } from "../../../../shared/types.ts";
import {
  formatDateTime,
  formatInterval,
  formatShortDateTime,
} from "../../lib/format";
import {
  STATUS_LABEL,
  checkMark,
  describeNextRun,
  elapsedText,
  modelAnchor,
  modelHeading,
  nextRunText,
  pickTab,
  prunePicks,
  runningCheck,
  type Picked,
} from "./board-logic";
import { CheckView } from "./CheckView";
import { useNow } from "./now";
import { StatusMark } from "./StatusMark";

/** 一个模型一张卡：标题、设置、状态，下面是它的各条检测题 */
export function ModelCard({ model }: { model: BoardModel }) {
  const { title, modelId } = modelHeading(model);
  const [tab, setTab] = useState<string | null>(null);
  const active = pickTab(model.checks, tab);
  const [firstCheck] = model.checks;

  // 各条题在"历史"里选中的那一次，按提示词 id 存在这里而不是题里面：
  // 未选中的页签不渲染内容，放在题里面的话一切换就丢了
  const [pickedState, setPickedState] = useState<
    Readonly<Record<number, Picked>>
  >({});
  // 检测题被撤掉、或者记录被管理员清空时，选中的那次作废，新结果来了也不再冒出来。
  // 清空后两次刷新之间就出了新结果（这里看不到"没有记录"）的，由 CheckView 去确认还在不在
  const picks = prunePicks(pickedState, model.checks);
  if (picks !== pickedState) setPickedState(picks);
  const checkView = (check: BoardCheck, single: boolean) => {
    const promptId = check.prompt.id;
    // 按提示词区分实例：只有一条题时换了一道题，展开之类的状态不带过去
    return (
      <CheckView
        key={promptId}
        model={model}
        check={check}
        single={single}
        picked={picks[promptId] ?? null}
        onPickedChange={(next) =>
          setPickedState((prev) => {
            const copy = { ...prev };
            if (next) copy[promptId] = next;
            else delete copy[promptId];
            return copy;
          })
        }
      />
    );
  };

  let body: ReactNode;
  if (!firstCheck) {
    body = (
      <p className="px-4 py-8 text-center text-sm text-ink-secondary">
        这个模型还没有分配检测题。
      </p>
    );
  } else if (model.checks.length === 1) {
    body = checkView(firstCheck, true);
  } else {
    body = (
      <Tabs
        value={active ?? ""}
        onValueChange={setTab}
        variant="block"
        size="sm"
      >
        <TabList aria-label="检测题" className="border-b border-line">
          {model.checks.map((check) => {
            const mark = checkMark(check);
            return (
              <Tab key={check.prompt.id} value={String(check.prompt.id)}>
                <span className="inline-flex items-center gap-2">
                  <StatusMark status={mark} />
                  <span
                    className="max-w-32 truncate"
                    title={check.prompt.title}
                  >
                    {check.prompt.title}
                  </span>
                  <span className="sr-only">
                    （{mark ? STATUS_LABEL[mark] : "还没有检测"}）
                  </span>
                </span>
              </Tab>
            );
          })}
        </TabList>
        {model.checks.map((check) => (
          <TabPanel key={check.prompt.id} value={String(check.prompt.id)}>
            {checkView(check, false)}
          </TabPanel>
        ))}
      </Tabs>
    );
  }

  return (
    <Panel id={modelAnchor(model.id)} className="min-w-0 scroll-mt-20">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-2">
          <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-base leading-snug font-bold wrap-anywhere">
              {title}
            </span>
            {modelId && (
              <span className="font-mono text-xs text-ink-tertiary wrap-anywhere">
                {modelId}
              </span>
            )}
          </h3>
          <div className="flex flex-wrap gap-2">
            <TagPair
              size="sm"
              name="模式"
              value={model.stream ? "流式" : "非流式"}
            />
            <TagPair
              size="sm"
              name="间隔"
              value={`每 ${formatInterval(model.intervalMinutes)}`}
            />
            <TagPair
              size="sm"
              name="超时"
              value={`${model.timeoutSeconds} 秒`}
            />
          </div>
        </div>
        <ModelSchedule model={model} />
      </header>
      {body}
    </Panel>
  );
}

/** 卡片右上角：检测中，或者下次什么时候检测。跟着时钟走 */
function ModelSchedule({ model }: { model: BoardModel }) {
  const now = useNow();
  const info = describeNextRun(model, now);

  if (info.state === "running") {
    const current = runningCheck(model);
    return (
      <div className="flex min-w-0 flex-col gap-1.5 sm:items-end sm:text-right">
        <Tag
          variant="accent"
          size="md"
          className="gap-2 self-start sm:self-end"
        >
          <Spinner size="sm" label={null} />
          检测中
        </Tag>
        <p className="max-w-72 truncate text-xs text-ink-secondary">
          {current?.latest ? (
            <>
              {model.checks.length > 1 && `「${current.prompt.title}」· `}
              <span className="font-tech tabular-nums">
                已进行 {elapsedText(current.latest.startedAt, now)}
              </span>
            </>
          ) : (
            "排队等待中"
          )}
        </p>
      </div>
    );
  }

  const at = "at" in info ? info.at : null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:items-end sm:text-right">
      <p className="text-sm">
        <span className="text-ink-secondary">下次检测：</span>
        <span className="font-medium">{nextRunText(info)}</span>
      </p>
      {at && (
        <time
          dateTime={at}
          title={formatDateTime(at)}
          className="font-tech text-xs text-ink-tertiary tabular-nums"
        >
          {formatShortDateTime(at)}
        </time>
      )}
    </div>
  );
}
