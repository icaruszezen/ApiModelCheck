/**
 * 渠道：大模型 API 的接入点。列表 + 抽屉表单；"启用"开关拨了立即保存。
 */
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  Plus,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tooltip,
  useToast,
} from "@endfield-ui/react";
import { useState, type ReactNode } from "react";
import { ENDPOINT_META } from "../../../../shared/endpoints.ts";
import type { AdminChannel } from "../../../../shared/types.ts";
import { adminApi, ApiRequestError } from "../../api/client";
import { EditIcon, TrashIcon } from "../../components/icons";
import { formatNumber } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { ChannelEditor } from "./channel-editor";
import { channelToggleInput, effectiveBaseUrl } from "./channel-form";
import { AdminPage, ConfirmDialog, errorMessage } from "./ui";

interface EditorState {
  open: boolean;
  channel: AdminChannel | null;
  /** 每次打开加一，给抽屉换 key，表单从头开始 */
  session: number;
}

const without = (set: ReadonlySet<number>, id: number) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function ChannelsPage() {
  const toast = useToast();
  const channels = useAsync(() => adminApi.channels(), []);
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    channel: null,
    session: 0,
  });
  // 删除确认框关上的动画里还要显示名称，所以"删谁"和"开没开"分开存
  const [deleting, setDeleting] = useState<AdminChannel | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toggling, setToggling] = useState<ReadonlySet<number>>(new Set());
  const [testing, setTesting] = useState<ReadonlySet<number>>(new Set());

  const openEditor = (channel: AdminChannel | null) =>
    setEditor((previous) => ({
      open: true,
      channel,
      session: previous.session + 1,
    }));

  const replaceLocal = (
    id: number,
    patch: (row: AdminChannel) => AdminChannel,
  ) =>
    channels.setData((previous) =>
      previous?.map((row) => (row.id === id ? patch(row) : row)),
    );

  const handleSaved = (saved: AdminChannel, created: boolean) => {
    setEditor((previous) => ({ ...previous, open: false }));
    channels.setData((previous) => {
      if (!previous) return [saved];
      return created
        ? [...previous, saved]
        : previous.map((row) => (row.id === saved.id ? saved : row));
    });
    toast({
      message: created
        ? `已创建渠道"${saved.name}"`
        : `已保存渠道"${saved.name}"`,
      tone: "success",
    });
    // 重新取一遍：排序值改了要换位置
    void channels.reload();
  };

  const toggle = async (channel: AdminChannel, enabled: boolean) => {
    setToggling((previous) => new Set(previous).add(channel.id));
    replaceLocal(channel.id, (row) => ({ ...row, enabled }));
    try {
      const saved = await adminApi.updateChannel(
        channel.id,
        channelToggleInput(channel, enabled),
      );
      replaceLocal(channel.id, () => saved);
      toast({
        message: enabled
          ? `已启用渠道"${channel.name}"`
          : `已停用渠道"${channel.name}"，它下面的模型不再检测`,
        tone: "success",
      });
    } catch (error) {
      replaceLocal(channel.id, (row) => ({ ...row, enabled: channel.enabled }));
      toast({
        message: `没能${enabled ? "启用" : "停用"}"${channel.name}"：${errorMessage(error)}`,
        tone: "danger",
      });
    } finally {
      setToggling((previous) => without(previous, channel.id));
    }
  };

  const testConnection = async (channel: AdminChannel) => {
    setTesting((previous) => new Set(previous).add(channel.id));
    try {
      const { models } = await adminApi.upstreamModels(channel.id);
      toast({
        message:
          models.length > 0
            ? `${channel.name}：连接正常，上游有 ${formatNumber(models.length)} 个模型`
            : `${channel.name}：连接正常，但上游没有返回任何模型`,
        tone: "success",
      });
    } catch (error) {
      toast({
        message: `${channel.name}：连接失败。${errorMessage(error)}`,
        tone: "danger",
        // 上游的错误信息往往较长，多留一会儿
        duration: 10_000,
      });
    } finally {
      setTesting((previous) => without(previous, channel.id));
    }
  };

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    try {
      await adminApi.deleteChannel(target.id);
      toast({ message: `已删除渠道"${target.name}"`, tone: "success" });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        // 已经被别处删掉了：结果一样，刷新列表即可
        toast({ message: `渠道"${target.name}"已经不存在了`, tone: "info" });
      } else {
        toast({
          message: `没能删除"${target.name}"：${errorMessage(error)}`,
          tone: "danger",
        });
        throw error;
      }
    }
    channels.setData((previous) =>
      previous?.filter((row) => row.id !== target.id),
    );
    void channels.reload();
  };

  const list = channels.data;
  let body: ReactNode;
  if (list === undefined) {
    body = channels.error ? (
      <EmptyState
        title="渠道列表没能加载"
        description={channels.error.message}
        action={
          <Button
            loading={channels.loading}
            onClick={() => void channels.reload()}
          >
            重试
          </Button>
        }
      />
    ) : (
      <div
        aria-busy="true"
        aria-label="正在加载渠道"
        className="flex flex-col gap-1"
      >
        <Skeleton className="h-8" />
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
      </div>
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        title="还没有渠道"
        description="渠道就是一个大模型 API 的接入点（OpenAI、Anthropic、Gemini，或兼容它们的中转）。先建渠道，再到“模型”页添加要检测的模型。"
        action={
          <Button
            iconStart={<Plus size={16} />}
            onClick={() => openEditor(null)}
          >
            新建渠道
          </Button>
        }
      />
    );
  } else {
    body = (
      <Table label="渠道列表">
        <TableHead>
          <TableRow>
            <TableHeaderCell>名称</TableHeaderCell>
            <TableHeaderCell>端点类型</TableHeaderCell>
            <TableHeaderCell>基础地址</TableHeaderCell>
            <TableHeaderCell>密钥</TableHeaderCell>
            <TableHeaderCell numeric>模型数</TableHeaderCell>
            <TableHeaderCell>启用</TableHeaderCell>
            <TableHeaderCell align="end">操作</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map((channel) => {
            const base = effectiveBaseUrl(channel);
            const isTesting = testing.has(channel.id);
            return (
              <TableRow key={channel.id}>
                <TableCell rowHeader>
                  <button
                    type="button"
                    onClick={() => openEditor(channel)}
                    title={channel.name}
                    className="block max-w-48 truncate text-left font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    {channel.name}
                  </button>
                </TableCell>
                <TableCell>
                  {ENDPOINT_META[channel.endpointType].label}
                </TableCell>
                <TableCell>
                  <span
                    title={base.url}
                    className={
                      base.isDefault
                        ? "block max-w-72 truncate text-ink-tertiary"
                        : "block max-w-72 truncate font-mono text-xs"
                    }
                  >
                    {base.isDefault ? (
                      <>
                        <span className="font-mono text-xs">{base.url}</span>
                        （默认）
                      </>
                    ) : (
                      base.url
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  {channel.hasApiKey ? (
                    <span className="font-mono text-xs">
                      {channel.apiKeyMasked}
                    </span>
                  ) : (
                    <span className="text-ink-tertiary">未设置</span>
                  )}
                </TableCell>
                <TableCell numeric>
                  {formatNumber(channel.modelCount)}
                </TableCell>
                <TableCell>
                  <Switch
                    aria-label={`启用渠道"${channel.name}"`}
                    checked={channel.enabled}
                    disabled={toggling.has(channel.id)}
                    onCheckedChange={(checked) => void toggle(channel, checked)}
                  />
                </TableCell>
                <TableCell align="end">
                  <div className="inline-flex items-center gap-3">
                    <Button
                      variant="text"
                      size="sm"
                      loading={isTesting}
                      aria-label={`测试连接：${channel.name}`}
                      onClick={() => void testConnection(channel)}
                    >
                      {isTesting ? "测试中" : "测试连接"}
                    </Button>
                    <span className="inline-flex gap-1">
                      <Tooltip content="编辑">
                        <IconButton
                          size="sm"
                          aria-label={`编辑渠道"${channel.name}"`}
                          onClick={() => openEditor(channel)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip content="删除">
                        <IconButton
                          size="sm"
                          aria-label={`删除渠道"${channel.name}"`}
                          onClick={() => {
                            setDeleting(channel);
                            setDeleteOpen(true);
                          }}
                        >
                          <TrashIcon />
                        </IconButton>
                      </Tooltip>
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <AdminPage
      title="渠道"
      meta="// CHANNELS"
      description="大模型 API 的接入点。每个渠道选一种端点类型，下面挂要检测的模型。"
      actions={
        <Button
          variant="action"
          iconStart={<Plus size={16} />}
          onClick={() => openEditor(null)}
        >
          新建渠道
        </Button>
      }
    >
      {list !== undefined && channels.error && (
        <Alert
          tone="warning"
          title="列表没能刷新"
          action={
            <Button
              variant="text"
              size="sm"
              onClick={() => void channels.reload()}
            >
              重试
            </Button>
          }
        >
          <span className="block">{channels.error.message}</span>
          <span className="block">下面显示的是上一次取到的数据。</span>
        </Alert>
      )}
      {body}

      <ChannelEditor
        key={editor.session}
        open={editor.open}
        channel={editor.channel}
        onOpenChange={(open) =>
          setEditor((previous) => ({ ...previous, open }))
        }
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={deleting ? `删除渠道"${deleting.name}"？` : "删除渠道？"}
        description={
          deleting && deleting.modelCount > 0
            ? `它下面的 ${formatNumber(deleting.modelCount)} 个模型，以及这些模型的全部检测记录会一起删除，正在进行的检测会被中止。删除后无法恢复。`
            : "这个渠道下面还没有模型。删除后无法恢复。"
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
      />
    </AdminPage>
  );
}
