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
import type { BoardModel } from "../../../../shared/types.ts";
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
  runningCheck,
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

  let body: ReactNode;
  if (!firstCheck) {
    body = (
      <p className="px-4 py-8 text-center text-sm text-ink-secondary">
        这个模型还没有分配检测题。
      </p>
    );
  } else if (model.checks.length === 1) {
    // 按提示词区分实例：换了一道题时，历史选择之类的状态不带过去
    body = (
      <CheckView
        key={firstCheck.prompt.id}
        model={model}
        check={firstCheck}
        single
      />
    );
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
                    className="max-w-48 truncate"
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
            <CheckView model={model} check={check} single={false} />
          </TabPanel>
        ))}
      </Tabs>
    );
  }

  return (
    <Panel id={modelAnchor(model.id)} className="min-w-0 scroll-mt-20">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-4 py-3.5">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
          <h3 className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className="text-lg leading-snug font-bold wrap-anywhere">
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
