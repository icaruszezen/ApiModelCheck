import { Button, Select, type SelectOption } from "@endfield-ui/react";
import { useEffect, useRef, useState } from "react";
import type { ResultSummary } from "../../../../shared/types.ts";
import { publicApi } from "../../api/client";
import { buildHistoryOptions } from "./board-logic";

const HISTORY_LIMIT = 20;
/** 占位选项的值：不会和记录的 id 撞上 */
const STATUS_VALUE = "__status";

export interface HistoryPickerProps {
  modelId: number;
  promptId: number;
  /** 最近一条记录的 id；从没检测过是 null */
  latestId: number | null;
  /**
   * 最近一条记录的"版本"（id + 状态）。它变了说明有新结果或者检测刚结束，
   * 下次打开下拉时重新拉列表
   */
  latestKey: string;
  /** 正在看的历史记录；看的是最新结果时是 null */
  selectedId: number | null;
  /** 正在看的那条的摘要（已经载入时），用来在它被挤出最近 20 条后仍写得出是哪一次 */
  selected: ResultSummary | null;
  /** 选了某一次；传 null 表示回到最新 */
  onPick: (id: number | null) => void;
}

/** "历史"下拉：最近 20 次，打开时才去拉列表 */
export function HistoryPicker({
  modelId,
  promptId,
  latestId,
  latestKey,
  selectedId,
  selected,
  onPick,
}: HistoryPickerProps) {
  const [list, setList] = useState<{
    key: string;
    items: ResultSummary[];
  } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const seq = useRef(0);

  // 卸载后晚到的响应不再落进来
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const load = () => {
    const id = ++seq.current;
    const key = latestKey;
    setStatus("loading");
    publicApi.history(modelId, promptId, HISTORY_LIMIT).then(
      (response) => {
        if (id !== seq.current) return;
        setList({ key, items: response.items });
        setStatus("idle");
      },
      () => {
        if (id !== seq.current) return;
        setStatus("error");
      },
    );
  };

  const onOpenChange = (open: boolean) => {
    if (!open || status === "loading") return;
    if (list === null || list.key !== latestKey) load();
  };

  let items: SelectOption[] = buildHistoryOptions(
    list?.items ?? [],
    latestId,
    selected,
  );
  // 手里还没有列表时，用一个点不了的选项说明状态；有旧列表时先照旧显示，新的到了再换
  if (list === null) {
    if (status === "error") {
      items = [
        {
          value: STATUS_VALUE,
          label: "载入失败，关上再打开重试",
          disabled: true,
        },
      ];
    } else if (items.length === 0) {
      items = [{ value: STATUS_VALUE, label: "正在载入…", disabled: true }];
    }
  } else if (items.length === 0) {
    items = [{ value: STATUS_VALUE, label: "还没有历史记录", disabled: true }];
  }

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 sm:w-auto">
      {selectedId !== null && (
        <Button variant="text" size="sm" onClick={() => onPick(null)}>
          回到最新
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-ink-secondary"
        >
          历史
        </span>
        <Select
          size="sm"
          aria-label="历史记录"
          className="min-w-0 flex-1 sm:w-64 sm:flex-none"
          placeholder={`最近 ${HISTORY_LIMIT} 次检测`}
          items={items}
          value={selectedId === null ? null : String(selectedId)}
          onOpenChange={onOpenChange}
          onValueChange={(value) => {
            if (value === STATUS_VALUE) return;
            const id = Number(value);
            if (!Number.isInteger(id)) return;
            onPick(id === latestId ? null : id);
          }}
        />
      </div>
    </div>
  );
}
