/**
 * 新建 / 编辑模型的右侧抽屉表单。
 * 每次打开都由父组件换一个 key 重新挂载，表单状态从头初始化；关闭动画期间内容保持不变。
 */
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Drawer,
  Field,
  Input,
  Segment,
  SegmentedControl,
  Select,
  Switch,
  Tag,
  useToast,
} from "@endfield-ui/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";
import { Link } from "react-router";
import { ENDPOINT_META } from "../../../../shared/endpoints.ts";
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
} from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import { formatInterval } from "../../lib/format";
import {
  INTERVAL_UNITS,
  buildModelInput,
  firstErrorField,
  isIntervalUnit,
  modelToForm,
  newModelForm,
  parseInteger,
  toMinutes,
  validateModelForm,
  MODEL_LIMITS,
  type ModelFormField,
  type ModelFormState,
} from "./model-form";
import { modelLabel } from "./model-list";
import { errorMessage } from "./ui";

export interface ModelEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要编辑的模型；新建时为 null */
  model: AdminModel | null;
  channels: readonly AdminChannel[];
  prompts: readonly AdminPrompt[];
  /** 保存成功（抽屉随后自己关上） */
  onSaved: (model: AdminModel, created: boolean) => void;
}

type UpstreamState =
  | { channelId: number; status: "loading" }
  | { channelId: number; status: "done"; models: string[] }
  | { channelId: number; status: "error"; error: string };

const linkClass =
  "underline underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ModelEditor({
  open,
  onOpenChange,
  model,
  channels,
  prompts,
  onSaved,
}: ModelEditorProps) {
  const toast = useToast();
  const baseId = useId();
  const formId = `${baseId}-form`;
  const fieldId = (field: ModelFormField) => `${baseId}-${field}`;

  const [form, setForm] = useState<ModelFormState>(() =>
    model ? modelToForm(model) : newModelForm(channels, prompts),
  );
  // 第一次点保存之后才显示错误，之后随输入实时更新
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const [upstream, setUpstream] = useState<UpstreamState | null>(null);
  const upstreamSeq = useRef(0);

  const errors = attempted ? validateModelForm(form) : {};
  const update = <K extends keyof ModelFormState>(
    key: K,
    value: ModelFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (serverError) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [serverError]);

  const channel = channels.find((item) => String(item.id) === form.channelId);
  const channelItems = useMemo(
    () =>
      channels.map((item) => ({
        value: String(item.id),
        label: item.enabled ? item.name : `${item.name}（已停用）`,
      })),
    [channels],
  );

  // 只认当前所选渠道的结果：换了渠道，之前拉到的列表就不显示了
  const currentUpstream =
    upstream && String(upstream.channelId) === form.channelId ? upstream : null;

  const fetchUpstream = async () => {
    const channelId = parseInteger(form.channelId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) return;
    const seq = ++upstreamSeq.current;
    setUpstream({ channelId, status: "loading" });
    try {
      const { models } = await adminApi.upstreamModels(channelId);
      if (seq === upstreamSeq.current) {
        setUpstream({ channelId, status: "done", models });
      }
    } catch (error) {
      if (seq === upstreamSeq.current) {
        setUpstream({ channelId, status: "error", error: errorMessage(error) });
      }
    }
  };

  const knownPromptIds = useMemo(
    () => new Set(prompts.map((prompt) => prompt.id)),
    [prompts],
  );
  const selectedPrompts = form.promptIds.filter((id) => knownPromptIds.has(id));
  const togglePrompt = (id: number, checked: boolean) =>
    setForm((prev) => ({
      ...prev,
      promptIds: checked
        ? [...prev.promptIds.filter((item) => item !== id), id]
        : prev.promptIds.filter((item) => item !== id),
    }));

  const intervalPreview = (() => {
    const value = parseInteger(form.intervalValue);
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    const minutes = toMinutes(value, form.intervalUnit);
    if (
      minutes < MODEL_LIMITS.intervalMin ||
      minutes > MODEL_LIMITS.intervalMax
    ) {
      return null;
    }
    return formatInterval(minutes);
  })();

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setAttempted(true);
    // 列表载入之后被别处删掉的提示词不再提交，否则服务端会整单拒绝
    const built = buildModelInput({ ...form, promptIds: selectedPrompts });
    if (!built.ok) {
      const field = firstErrorField(built.errors);
      if (field) document.getElementById(fieldId(field))?.focus();
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      const saved = model
        ? await adminApi.updateModel(model.id, built.input)
        : await adminApi.createModel(built.input);
      toast({
        message: model
          ? `已保存「${modelLabel(saved)}」`
          : `已添加「${modelLabel(saved)}」`,
        tone: "success",
      });
      onSaved(saved, model === null);
      onOpenChange(false);
    } catch (error) {
      setServerError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        // 保存进行中不关，免得请求结果没人接
        if (!saving || next) onOpenChange(next);
      }}
      size="lg"
      title={model ? "编辑模型" : "新建模型"}
      description={
        model
          ? "修改从下一轮检测开始生效，正在进行的这一轮不受影响。"
          : "选择渠道和模型、分配检测题，再设定请求方式与检测间隔。"
      }
      footer={
        <>
          <Button
            variant="light"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="submit" form={formId} variant="action" loading={saving}>
            {model ? "保存" : "添加模型"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-8"
      >
        {serverError && (
          <Alert
            ref={alertRef}
            tone="danger"
            title="没有保存成功"
            onClose={() => setServerError(null)}
          >
            {serverError}
          </Alert>
        )}

        <FormSection title="检测对象">
          <Field
            label="渠道"
            required
            controlId={fieldId("channelId")}
            error={errors.channelId}
            help={
              channel
                ? `接口类型：${ENDPOINT_META[channel.endpointType].label}${
                    channel.enabled
                      ? ""
                      : "。这个渠道已停用，它下面的模型不会被检测"
                  }`
                : undefined
            }
          >
            <Select
              items={channelItems}
              placeholder="选择渠道"
              value={form.channelId || null}
              onValueChange={(value) => update("channelId", value)}
            />
          </Field>

          <div className="flex flex-col gap-3">
            <Field
              label="模型 ID"
              required
              controlId={fieldId("model")}
              error={errors.model}
              help="上游接口里的模型名，如 gpt-4o、claude-sonnet-4-5、gemini-2.5-pro。"
            >
              <div className="flex gap-2">
                <Input
                  className="min-w-0 flex-1"
                  value={form.model}
                  onChange={(event) => update("model", event.target.value)}
                  placeholder="手动填写，或从渠道获取"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="light"
                  loading={currentUpstream?.status === "loading"}
                  disabled={!channel}
                  onClick={() => void fetchUpstream()}
                >
                  从渠道获取
                </Button>
              </div>
            </Field>
            <UpstreamPicker
              state={currentUpstream}
              value={form.model}
              onPick={(value) => update("model", value)}
              onRetry={() => void fetchUpstream()}
            />
          </div>

          <Field
            label="显示名"
            controlId={fieldId("displayName")}
            error={errors.displayName}
            help="前台卡片上的标题。"
          >
            <Input
              value={form.displayName}
              onChange={(event) => update("displayName", event.target.value)}
              placeholder="留空则显示模型 ID"
              autoComplete="off"
            />
          </Field>
        </FormSection>

        <FormSection title="检测题">
          <Field
            group
            label="要检测的提示词"
            help={
              prompts.length === 0
                ? undefined
                : selectedPrompts.length === 0
                  ? "一条都不勾选时，这个模型不会被检测。"
                  : "每轮按提示词的排序依次检测；停用的提示词会被跳过。"
            }
          >
            <div className="flex w-full flex-col gap-2">
              {prompts.length === 0 ? (
                <p className="text-sm text-ink-secondary">
                  还没有提示词。
                  <Link to="/admin/prompts" className={linkClass}>
                    去添加提示词
                  </Link>
                  ，回来再分配给这个模型。
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-tech text-sm text-ink-secondary tabular-nums">
                      已选 {selectedPrompts.length} / {prompts.length}
                    </span>
                    <span className="flex items-center gap-4">
                      <Button
                        variant="text"
                        size="sm"
                        iconEnd={null}
                        disabled={selectedPrompts.length === prompts.length}
                        onClick={() =>
                          update(
                            "promptIds",
                            prompts.map((prompt) => prompt.id),
                          )
                        }
                      >
                        全选
                      </Button>
                      <Button
                        variant="text"
                        size="sm"
                        iconEnd={null}
                        disabled={selectedPrompts.length === 0}
                        onClick={() => update("promptIds", [])}
                      >
                        全不选
                      </Button>
                    </span>
                  </div>
                  <div className="flex max-h-72 flex-col overflow-y-auto overscroll-contain border border-line px-3 py-1">
                    {prompts.map((prompt) => (
                      <Checkbox
                        key={prompt.id}
                        checked={form.promptIds.includes(prompt.id)}
                        onCheckedChange={(checked) =>
                          togglePrompt(prompt.id, checked)
                        }
                      >
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="wrap-anywhere">{prompt.title}</span>
                          {!prompt.enabled && (
                            <Tag size="sm" variant="muted">
                              已停用
                            </Tag>
                          )}
                        </span>
                      </Checkbox>
                    ))}
                  </div>
                </>
              )}
            </div>
          </Field>
        </FormSection>

        <FormSection title="请求与调度">
          <Field
            label="请求方式"
            help={
              form.stream
                ? "边生成边接收：能记录首字延迟，前台可以看到正在生成的内容。"
                : "等模型全部生成完再一次返回：有的中转对非流式更稳定，但看不到生成过程。"
            }
          >
            <SegmentedControl
              value={form.stream ? "stream" : "plain"}
              onValueChange={(value) => update("stream", value === "stream")}
            >
              <Segment value="stream">流式</Segment>
              <Segment value="plain">非流式</Segment>
            </SegmentedControl>
          </Field>

          <Field
            label="超时时间（秒）"
            required
            controlId={fieldId("timeoutSeconds")}
            error={errors.timeoutSeconds}
            help="5 – 3600 秒。到时还没生成完记为超时，已经收到的部分照样保存。"
          >
            <Input
              className="max-w-48"
              inputMode="numeric"
              value={form.timeoutSeconds}
              onChange={(event) => update("timeoutSeconds", event.target.value)}
              end="秒"
              autoComplete="off"
            />
          </Field>

          <Field
            label="检测间隔"
            required
            controlId={fieldId("interval")}
            error={errors.interval}
            help={
              intervalPreview
                ? `每 ${intervalPreview}检测一轮，从上一轮开始的时间算起。范围 1 分钟到 7 天。`
                : "从上一轮开始的时间算起。范围 1 分钟到 7 天。"
            }
          >
            <div className="flex max-w-80 gap-2">
              <Input
                className="min-w-0 flex-1"
                inputMode="numeric"
                value={form.intervalValue}
                onChange={(event) =>
                  update("intervalValue", event.target.value)
                }
                autoComplete="off"
              />
              {/* 字段的 id 给了左边的输入框；这里自己给 id 和名称，免得重复 */}
              <Select
                id={`${baseId}-interval-unit`}
                aria-label="间隔单位"
                className="w-28 shrink-0"
                items={INTERVAL_UNITS}
                value={form.intervalUnit}
                onValueChange={(value) => {
                  if (isIntervalUnit(value)) update("intervalUnit", value);
                }}
              />
            </div>
          </Field>
        </FormSection>

        <FormSection title="高级">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field
              label="最大输出 tokens"
              controlId={fieldId("maxTokens")}
              error={errors.maxTokens}
              help="留空则不传；Anthropic 接口必须传，留空时用 8192"
            >
              <Input
                inputMode="numeric"
                value={form.maxTokens}
                onChange={(event) => update("maxTokens", event.target.value)}
                placeholder="不传"
                autoComplete="off"
              />
            </Field>
            <Field
              label="温度"
              controlId={fieldId("temperature")}
              error={errors.temperature}
              help="0 – 2；留空则用上游的默认值。"
            >
              <Input
                inputMode="decimal"
                value={form.temperature}
                onChange={(event) => update("temperature", event.target.value)}
                placeholder="不传"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            label="排序"
            controlId={fieldId("sortOrder")}
            error={errors.sortOrder}
            help="同一渠道里数字小的排在前面，前台也按这个顺序。"
          >
            <Input
              className="max-w-48"
              inputMode="numeric"
              value={form.sortOrder}
              onChange={(event) => update("sortOrder", event.target.value)}
              placeholder="0"
              autoComplete="off"
            />
          </Field>
          <div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => update("enabled", checked)}
            >
              启用
            </Switch>
            <p className="mt-1 text-sm text-ink-secondary">
              停用后不再定时检测，也不在前台显示；已有的检测记录保留。
            </p>
          </div>
        </FormSection>
      </form>
    </Drawer>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
        <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-ink" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "从渠道获取"之后的结果：可检索的模型列表，选中即填入模型 ID */
function UpstreamPicker({
  state,
  value,
  onPick,
  onRetry,
}: {
  state: UpstreamState | null;
  value: string;
  onPick: (value: string) => void;
  onRetry: () => void;
}) {
  const models = state?.status === "done" ? state.models : null;
  const items = useMemo(
    () => (models ?? []).map((id) => ({ value: id, label: id })),
    [models],
  );

  if (!state || state.status === "loading") return null;

  if (state.status === "error") {
    return (
      <Alert
        tone="danger"
        title="没能获取模型列表"
        action={
          <Button variant="text" size="sm" iconEnd={null} onClick={onRetry}>
            重试
          </Button>
        }
      >
        {state.error}
      </Alert>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-ink-secondary">
        渠道没有返回任何模型，请手动填写模型 ID。
      </p>
    );
  }

  const trimmed = value.trim();
  return (
    <Field
      label={`渠道提供的模型（${items.length} 个）`}
      help="输入关键字筛选，选中后填入上面的模型 ID。"
    >
      <Combobox
        items={items}
        value={state.models.includes(trimmed) ? trimmed : null}
        onValueChange={(next) => {
          if (next !== null) onPick(next);
        }}
        placeholder="输入关键字筛选"
        emptyText="没有匹配的模型"
      />
    </Field>
  );
}
