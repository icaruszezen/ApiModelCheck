/**
 * 后台"模型"页：选择对哪些模型做智商检测，并给每个模型单独设置请求方式、超时与检测间隔。
 */
import {
  Alert,
  Button,
  createIcon,
  EmptyState,
  Field,
  IconButton,
  Input,
  Plus,
  Select,
  Spinner,
  StatusWarning,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Tooltip,
  useToast,
} from "@endfield-ui/react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
} from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import {
  EditIcon,
  PlayIcon,
  ResultsIcon,
  TrashIcon,
} from "../../components/icons";
import { StatusTag } from "../../components/output/StatusTag";
import {
  formatDateTime,
  formatInterval,
  formatRelative,
  formatShortDateTime,
} from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { ModelEditor } from "./model-editor";
import { modelToInput } from "./model-form";
import { useNow, usePolling } from "./model-hooks";
import {
  NEXT_RUN_TEXT,
  anyRunning,
  describeNextRun,
  filterModels,
  modelLabel,
  promptStats,
  type PromptStats,
} from "./model-list";
import { AdminPage, ConfirmDialog, errorMessage } from "./ui";

const SearchIcon = createIcon("Search", <path d="M4 4h11v11H4zM15 15l5 5" />);

/** 有检测在进行时 5 秒刷新一次，平时 30 秒（"下次检测"到点后能看到它开始） */
const FAST_POLL = 5_000;
const IDLE_POLL = 30_000;
const COLUMN_COUNT = 10;

type EditorState = { session: number; model: AdminModel | null };

export function ModelsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const models = useAsync(() => adminApi.models(), []);
  const channels = useAsync(() => adminApi.channels(), []);
  const prompts = useAsync(() => adminApi.prompts(), []);

  const [channelFilter, setChannelFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminModel | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // 正在保存启用开关 / 正在发起"立即检测"的行
  const [toggling, setToggling] = useState<ReadonlySet<number>>(new Set());
  const [starting, setStarting] = useState<ReadonlySet<number>>(new Set());

  const list = models.data ?? [];
  const running = anyRunning(list);
  const now = useNow(15_000);
  usePolling(
    models.reload,
    models.data ? (running ? FAST_POLL : IDLE_POLL) : null,
  );

  const channelById = useMemo(
    () =>
      new Map((channels.data ?? []).map((channel) => [channel.id, channel])),
    [channels.data],
  );
  const channelItems = useMemo(
    () => [
      { value: "all", label: "全部渠道" },
      ...(channels.data ?? []).map((channel) => ({
        value: String(channel.id),
        label: channel.enabled ? channel.name : `${channel.name}（已停用）`,
      })),
    ],
    [channels.data],
  );
  // 选中的渠道被删掉了就回到"全部"
  const activeFilter = channelItems.some((item) => item.value === channelFilter)
    ? channelFilter
    : "all";
  const visible = filterModels(list, {
    channelId: activeFilter === "all" ? null : Number(activeFilter),
    query,
  });
  const filtering = activeFilter !== "all" || query.trim() !== "";

  const noChannels = channels.data !== undefined && channels.data.length === 0;
  const canCreate =
    channels.data !== undefined && prompts.data !== undefined && !noChannels;

  const markSet = (setter: typeof setToggling, id: number, on: boolean) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const replaceModel = (updated: AdminModel) =>
    models.setData((prev) =>
      prev?.map((item) => (item.id === updated.id ? updated : item)),
    );
  // 只改本地的几个字段（乐观更新），其余字段保留列表里最新的
  const patchModel = (id: number, patch: Partial<AdminModel>) =>
    models.setData((prev) =>
      prev?.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );

  const openEditor = (model: AdminModel | null) => {
    setEditor((prev) => ({ session: (prev?.session ?? 0) + 1, model }));
    setEditorOpen(true);
    // 渠道和提示词可能在别的页面改过：打开表单时顺手刷新，不挡着表单
    void channels.reload();
    void prompts.reload();
  };

  const runNow = async (model: AdminModel) => {
    markSet(setStarting, model.id, true);
    try {
      const { queued } = await adminApi.runModel(model.id);
      toast(
        queued
          ? { message: "已开始检测", tone: "success" }
          : { message: "这个模型正在检测中", tone: "info" },
      );
      // 先标成检测中，轮询立刻切到快档
      patchModel(model.id, { running: true });
      void models.reload();
    } catch (error) {
      toast({ message: errorMessage(error), tone: "danger" });
    } finally {
      markSet(setStarting, model.id, false);
    }
  };

  const toggleEnabled = async (model: AdminModel, enabled: boolean) => {
    markSet(setToggling, model.id, true);
    patchModel(model.id, { enabled });
    try {
      const updated = await adminApi.updateModel(
        model.id,
        modelToInput(model, { enabled }),
      );
      replaceModel(updated);
      toast({
        message: `${enabled ? "已启用" : "已停用"}「${modelLabel(updated)}」`,
        tone: "success",
      });
      // 丢掉保存前就发出的轮询结果
      void models.reload();
    } catch (error) {
      patchModel(model.id, { enabled: model.enabled });
      toast({ message: errorMessage(error), tone: "danger" });
    } finally {
      markSet(setToggling, model.id, false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteModel(deleteTarget.id);
    } catch (error) {
      toast({ message: errorMessage(error), tone: "danger" });
      throw error;
    }
    models.setData((prev) =>
      prev?.filter((item) => item.id !== deleteTarget.id),
    );
    toast({
      message: `已删除「${modelLabel(deleteTarget)}」及其检测记录`,
      tone: "success",
    });
    void models.reload();
  };

  let content;
  if (models.data === undefined) {
    content = models.error ? (
      <EmptyState
        title="模型列表没有载入"
        description={errorMessage(models.error)}
        action={
          <Button variant="light" onClick={() => void models.reload()}>
            重试
          </Button>
        }
      />
    ) : (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-secondary">
        <Spinner size="sm" label={null} />
        正在载入模型…
      </div>
    );
  } else if (list.length === 0) {
    content = (
      <EmptyState
        title="还没有检测模型"
        description={
          noChannels
            ? "模型挂在渠道下面：先添加一个渠道，再回来添加模型。"
            : "添加一个模型并分配检测题，平台会按设定的间隔自动向它提问。"
        }
        action={
          noChannels ? (
            <Button render={<Link to="/admin/channels" />}>去添加渠道</Button>
          ) : (
            <Button
              iconStart={<Plus size={16} />}
              disabled={!canCreate}
              onClick={() => openEditor(null)}
            >
              新建模型
            </Button>
          )
        }
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 bg-surface-sunken p-4">
          <Field label="渠道" className="w-full sm:w-56">
            <Select
              variant="outline"
              items={channelItems}
              value={activeFilter}
              onValueChange={setChannelFilter}
            />
          </Field>
          <Field label="搜索" className="min-w-48 flex-1">
            <Input
              variant="outline"
              type="search"
              start={<SearchIcon size={16} />}
              placeholder="显示名或模型 ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        <p role="status" className="text-sm text-ink-secondary">
          {filtering
            ? `共 ${list.length} 个模型，符合条件的 ${visible.length} 个`
            : `共 ${list.length} 个模型`}
          {running &&
            `，${list.filter((model) => model.running).length} 个正在检测`}
          {models.error && (
            <span className="ml-2 text-danger">
              刷新失败：{errorMessage(models.error)}
            </span>
          )}
        </p>

        <Table label="检测模型" stickyFirstColumn>
          <TableHead>
            <TableRow>
              <TableHeaderCell>模型</TableHeaderCell>
              <TableHeaderCell>渠道</TableHeaderCell>
              <TableHeaderCell>请求方式</TableHeaderCell>
              <TableHeaderCell>检测间隔</TableHeaderCell>
              <TableHeaderCell numeric>超时</TableHeaderCell>
              <TableHeaderCell>检测题</TableHeaderCell>
              <TableHeaderCell>最近检测</TableHeaderCell>
              <TableHeaderCell>下次检测</TableHeaderCell>
              <TableHeaderCell>启用</TableHeaderCell>
              <TableHeaderCell align="end">操作</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="py-6 whitespace-normal"
                >
                  <EmptyState
                    bordered={false}
                    title="没有符合条件的模型"
                    description="换一个渠道或关键字，或者清掉筛选条件。"
                    action={
                      <Button
                        variant="light"
                        onClick={() => {
                          setChannelFilter("all");
                          setQuery("");
                        }}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )}
            {visible.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                channel={channelById.get(model.channelId)}
                prompts={prompts.data}
                now={now}
                toggling={toggling.has(model.id)}
                starting={starting.has(model.id)}
                editable={
                  channels.data !== undefined && prompts.data !== undefined
                }
                onToggle={(enabled) => void toggleEnabled(model, enabled)}
                onRun={() => void runNow(model)}
                onEdit={() => openEditor(model)}
                onResults={() => navigate(`/admin/results?modelId=${model.id}`)}
                onDelete={() => {
                  setDeleteTarget(model);
                  setDeleteOpen(true);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <AdminPage
      title="模型"
      meta="// MODELS"
      description="选择要做智商检测的模型，单独设置请求方式、超时时间和检测间隔。"
      actions={
        <Button
          variant="action"
          iconStart={<Plus size={16} />}
          disabled={!canCreate}
          onClick={() => openEditor(null)}
        >
          新建模型
        </Button>
      }
    >
      {/* 表单要用渠道和提示词：其中一个没载入时说清楚为什么不能新建 */}
      {((channels.error && !channels.data) ||
        (prompts.error && !prompts.data)) && (
        <Alert
          tone="danger"
          title="渠道或提示词列表没有载入，暂时不能新建和编辑模型"
          action={
            <Button
              variant="text"
              size="sm"
              iconEnd={null}
              onClick={() => {
                if (!channels.data) void channels.reload();
                if (!prompts.data) void prompts.reload();
              }}
            >
              重试
            </Button>
          }
        >
          {errorMessage(channels.data ? prompts.error : channels.error)}
        </Alert>
      )}
      {noChannels && list.length > 0 && (
        <Alert tone="warning" title="没有可用的渠道">
          新建模型前要先有渠道，
          <Link
            to="/admin/channels"
            className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            去添加渠道
          </Link>
          。
        </Alert>
      )}
      {content}

      {editor && channels.data && prompts.data && (
        <ModelEditor
          key={editor.session}
          open={editorOpen}
          onOpenChange={setEditorOpen}
          model={editor.model}
          channels={channels.data}
          prompts={prompts.data}
          onSaved={(saved, created) => {
            if (created) {
              models.setData((prev) => (prev ? [...prev, saved] : [saved]));
            } else {
              replaceModel(saved);
            }
            void models.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={
          deleteTarget ? `删除「${modelLabel(deleteTarget)}」？` : "删除模型？"
        }
        description="这个模型的全部检测记录会一起删除，无法恢复。正在进行的检测会被中止。"
        confirmLabel="删除"
        onConfirm={confirmDelete}
      />
    </AdminPage>
  );
}

interface ModelRowProps {
  model: AdminModel;
  channel: AdminChannel | undefined;
  prompts: readonly AdminPrompt[] | undefined;
  now: number;
  toggling: boolean;
  starting: boolean;
  /** 渠道和提示词都载入了才能打开表单 */
  editable: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onResults: () => void;
  onDelete: () => void;
}

function ModelRow({
  model,
  channel,
  prompts,
  now,
  toggling,
  starting,
  editable,
  onToggle,
  onRun,
  onEdit,
  onResults,
  onDelete,
}: ModelRowProps) {
  const label = modelLabel(model);
  const stats = promptStats(model, prompts);
  // 渠道列表还没载入时先当作启用，免得闪一下"渠道已停用"
  const channelEnabled = channel?.enabled ?? true;
  const next = describeNextRun(
    model,
    { channelEnabled, enabledPrompts: stats.enabled },
    now,
  );

  return (
    <TableRow>
      <TableCell rowHeader className="whitespace-normal">
        <div className="flex max-w-64 min-w-36 flex-col gap-0.5">
          <span className="wrap-anywhere">{label}</span>
          {label !== model.model && (
            <span className="font-mono text-xs font-normal text-ink-tertiary wrap-anywhere">
              {model.model}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-2">
          <span className="max-w-40 truncate" title={model.channelName}>
            {model.channelName}
          </span>
          {!channelEnabled && (
            <Tag size="sm" variant="muted">
              已停用
            </Tag>
          )}
        </span>
      </TableCell>
      <TableCell>
        <Tag size="sm" variant={model.stream ? "solid" : "outline"}>
          {model.stream ? "流式" : "非流式"}
        </Tag>
      </TableCell>
      <TableCell>{formatInterval(model.intervalMinutes)}</TableCell>
      <TableCell numeric>{model.timeoutSeconds} 秒</TableCell>
      <TableCell>
        <PromptCount stats={stats} />
      </TableCell>
      <TableCell>
        {model.running ? (
          <StatusTag status="running" />
        ) : model.lastStatus ? (
          <span className="inline-flex items-center gap-2">
            <StatusTag status={model.lastStatus} />
            {model.lastRunAt && (
              <time
                dateTime={model.lastRunAt}
                title={formatDateTime(model.lastRunAt)}
                className="font-tech text-xs text-ink-secondary tabular-nums"
              >
                {formatShortDateTime(model.lastRunAt)}
              </time>
            )}
          </span>
        ) : (
          <span className="text-ink-tertiary">从未检测</span>
        )}
      </TableCell>
      <TableCell>
        {next.kind === "at" ? (
          <Tooltip content={formatDateTime(next.at)}>
            <time
              dateTime={next.at}
              tabIndex={0}
              className="cursor-default underline decoration-line-strong decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {formatRelative(next.at, now)}
            </time>
          </Tooltip>
        ) : (
          <span
            className={
              next.kind === "soon" ? "text-ink-secondary" : "text-ink-tertiary"
            }
          >
            {NEXT_RUN_TEXT[next.kind]}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          aria-label={`启用 ${label}`}
          checked={model.enabled}
          disabled={toggling}
          onCheckedChange={onToggle}
          className="min-h-0 py-0"
        />
      </TableCell>
      <TableCell align="end">
        <div className="inline-flex items-center gap-1">
          <Tooltip content="立即检测">
            <IconButton
              size="sm"
              aria-label={`立即检测 ${label}`}
              disabled={starting}
              onClick={onRun}
            >
              {starting ? (
                <Spinner size="sm" label={null} />
              ) : (
                <PlayIcon size={16} />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip content="查看记录">
            <IconButton
              size="sm"
              aria-label={`查看 ${label} 的检测记录`}
              onClick={onResults}
            >
              <ResultsIcon size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip content="编辑">
            <IconButton
              size="sm"
              aria-label={`编辑 ${label}`}
              disabled={!editable}
              onClick={onEdit}
            >
              <EditIcon size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip content="删除">
            <IconButton
              size="sm"
              aria-label={`删除 ${label}`}
              onClick={onDelete}
            >
              <TrashIcon size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 检测题数：没有会被检测的题时给出警示 */
function PromptCount({ stats }: { stats: PromptStats }) {
  if (stats.enabled === 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <StatusWarning size={16} className="shrink-0 text-warning" />
        {stats.assigned === 0 ? "未分配" : "均已停用"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-tech tabular-nums">{stats.enabled}</span>
      {stats.disabled > 0 && (
        <span className="text-xs text-ink-tertiary">
          另有 {stats.disabled} 条已停用
        </span>
      )}
    </span>
  );
}
