/**
 * 提示词：发给模型的检测题。列表 + 抽屉表单；"启用"开关拨了立即保存。
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
import { useMemo, useState, type ReactNode } from "react";
import type { AdminPrompt } from "../../../../shared/types.ts";
import { adminApi, ApiRequestError } from "../../api/client";
import { EditIcon, TrashIcon } from "../../components/icons";
import { formatNumber } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { PromptEditor } from "./prompt-editor";
import {
  contentPreview,
  modelOptionLabel,
  promptToggleInput,
} from "./prompt-form";
import {
  AdminPage,
  ConfirmDialog,
  errorMessage,
  STICKY_END_CELL,
  STICKY_END_HEAD,
  stickyEndHeadRef,
} from "./ui";

interface EditorState {
  open: boolean;
  prompt: AdminPrompt | null;
  session: number;
}

const without = (set: ReadonlySet<number>, id: number) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function PromptsPage() {
  const toast = useToast();
  const prompts = useAsync(() => adminApi.prompts(), []);
  // 模型列表只用来显示名字和给表单选；它加载失败不影响提示词的列表
  const models = useAsync(() => adminApi.models(), []);
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    prompt: null,
    session: 0,
  });
  const [deleting, setDeleting] = useState<AdminPrompt | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toggling, setToggling] = useState<ReadonlySet<number>>(new Set());

  const modelNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const model of models.data ?? []) {
      map.set(model.id, modelOptionLabel(model));
    }
    return map;
  }, [models.data]);

  const openEditor = (prompt: AdminPrompt | null) => {
    // 模型列表上次没取到：打开表单时再试一次
    if (models.error && !models.loading) void models.reload();
    setEditor((previous) => ({
      open: true,
      prompt,
      session: previous.session + 1,
    }));
  };

  const replaceLocal = (id: number, patch: (row: AdminPrompt) => AdminPrompt) =>
    prompts.setData((previous) =>
      previous?.map((row) => (row.id === id ? patch(row) : row)),
    );

  const handleSaved = (saved: AdminPrompt, created: boolean) => {
    setEditor((previous) => ({ ...previous, open: false }));
    prompts.setData((previous) => {
      if (!previous) return [saved];
      return created
        ? [...previous, saved]
        : previous.map((row) => (row.id === saved.id ? saved : row));
    });
    toast({
      message: created
        ? `已创建提示词"${saved.title}"`
        : `已保存提示词"${saved.title}"`,
      tone: "success",
    });
    void prompts.reload();
    // 分配关系改了，模型那边的 promptIds 也变了
    void models.reload();
  };

  const toggle = async (prompt: AdminPrompt, enabled: boolean) => {
    setToggling((previous) => new Set(previous).add(prompt.id));
    replaceLocal(prompt.id, (row) => ({ ...row, enabled }));
    try {
      const saved = await adminApi.updatePrompt(
        prompt.id,
        promptToggleInput(prompt, enabled),
      );
      replaceLocal(prompt.id, () => saved);
      toast({
        message: enabled
          ? `已启用提示词"${prompt.title}"`
          : `已停用提示词"${prompt.title}"，不再检测`,
        tone: "success",
      });
    } catch (error) {
      replaceLocal(prompt.id, (row) => ({ ...row, enabled: prompt.enabled }));
      toast({
        message: `没能${enabled ? "启用" : "停用"}"${prompt.title}"：${errorMessage(error)}`,
        tone: "danger",
      });
    } finally {
      setToggling((previous) => without(previous, prompt.id));
    }
  };

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    try {
      await adminApi.deletePrompt(target.id);
      toast({ message: `已删除提示词"${target.title}"`, tone: "success" });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        toast({ message: `提示词"${target.title}"已经不存在了`, tone: "info" });
      } else {
        toast({
          message: `没能删除"${target.title}"：${errorMessage(error)}`,
          tone: "danger",
        });
        throw error;
      }
    }
    prompts.setData((previous) =>
      previous?.filter((row) => row.id !== target.id),
    );
    void prompts.reload();
    void models.reload();
  };

  const assignedTitle = (prompt: AdminPrompt) => {
    if (prompt.modelIds.length === 0) return "还没有分配给任何模型";
    const names = prompt.modelIds
      .map((id) => modelNames.get(id))
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join("\n") : undefined;
  };

  const list = prompts.data;
  let body: ReactNode;
  if (list === undefined) {
    body = prompts.error ? (
      <EmptyState
        title="提示词列表没能加载"
        description={prompts.error.message}
        action={
          <Button
            loading={prompts.loading}
            onClick={() => void prompts.reload()}
          >
            重试
          </Button>
        }
      />
    ) : (
      <div
        aria-busy="true"
        aria-label="正在加载提示词"
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
        title="还没有提示词"
        description="提示词就是发给模型的检测题。写好之后分配给模型，每轮检测都会把它发出去。"
        action={
          <Button
            iconStart={<Plus size={16} />}
            onClick={() => openEditor(null)}
          >
            新建提示词
          </Button>
        }
      />
    );
  } else {
    body = (
      <Table label="提示词列表">
        <TableHead>
          <TableRow>
            <TableHeaderCell>标题</TableHeaderCell>
            <TableHeaderCell>内容预览</TableHeaderCell>
            <TableHeaderCell numeric>应用的模型数</TableHeaderCell>
            <TableHeaderCell numeric>排序</TableHeaderCell>
            <TableHeaderCell>启用</TableHeaderCell>
            <TableHeaderCell
              align="end"
              className={STICKY_END_HEAD}
              ref={stickyEndHeadRef}
            >
              操作
            </TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map((prompt) => (
            <TableRow key={prompt.id}>
              <TableCell rowHeader>
                <button
                  type="button"
                  onClick={() => openEditor(prompt)}
                  title={prompt.title}
                  // 上下留一点内边距：truncate 会裁掉盒子外的东西，下划线贴着盒子底边时会时有时无
                  className="block max-w-48 truncate py-0.5 text-left font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {prompt.title}
                </button>
              </TableCell>
              <TableCell>
                <span
                  className="block max-w-[28rem] truncate text-ink-secondary"
                  title={contentPreview(prompt.content, 600)}
                >
                  {contentPreview(prompt.content)}
                </span>
              </TableCell>
              <TableCell numeric>
                <span title={assignedTitle(prompt)}>
                  {prompt.modelIds.length === 0 ? (
                    <span className="text-ink-tertiary">0</span>
                  ) : (
                    formatNumber(prompt.modelIds.length)
                  )}
                </span>
              </TableCell>
              <TableCell numeric>{prompt.sortOrder}</TableCell>
              <TableCell>
                <Switch
                  aria-label={`启用提示词"${prompt.title}"`}
                  checked={prompt.enabled}
                  disabled={toggling.has(prompt.id)}
                  onCheckedChange={(checked) => void toggle(prompt, checked)}
                />
              </TableCell>
              <TableCell align="end" className={STICKY_END_CELL}>
                <span className="inline-flex gap-1">
                  <Tooltip content="编辑">
                    <IconButton
                      size="sm"
                      aria-label={`编辑提示词"${prompt.title}"`}
                      onClick={() => openEditor(prompt)}
                    >
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="删除">
                    <IconButton
                      size="sm"
                      aria-label={`删除提示词"${prompt.title}"`}
                      onClick={() => {
                        setDeleting(prompt);
                        setDeleteOpen(true);
                      }}
                    >
                      <TrashIcon />
                    </IconButton>
                  </Tooltip>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  const deletingUsers = deleting?.modelIds.length ?? 0;

  return (
    <AdminPage
      title="提示词"
      meta="// PROMPTS"
      description="发给模型的检测题。一条提示词可以分配给多个模型，每个模型按排序依次检测分到的提示词。"
      actions={
        <Button
          variant="action"
          iconStart={<Plus size={16} />}
          onClick={() => openEditor(null)}
        >
          新建提示词
        </Button>
      }
    >
      {list !== undefined && prompts.error && (
        <Alert
          tone="warning"
          title="列表没能刷新"
          action={
            <Button
              variant="text"
              size="sm"
              onClick={() => void prompts.reload()}
            >
              重试
            </Button>
          }
        >
          <span className="block">{prompts.error.message}</span>
          <span className="block">下面显示的是上一次取到的数据。</span>
        </Alert>
      )}
      {body}

      <PromptEditor
        key={editor.session}
        open={editor.open}
        prompt={editor.prompt}
        models={models.data}
        modelsLoading={models.loading}
        modelsError={models.error}
        onRetryModels={() => void models.reload()}
        onOpenChange={(open) =>
          setEditor((previous) => ({ ...previous, open }))
        }
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={deleting ? `删除提示词"${deleting.title}"？` : "删除提示词？"}
        description={
          (deletingUsers > 0
            ? `目前有 ${formatNumber(deletingUsers)} 个模型在用它。`
            : "") + "它的分配关系和全部检测记录会一起删除，删除后无法恢复。"
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
      />
    </AdminPage>
  );
}
