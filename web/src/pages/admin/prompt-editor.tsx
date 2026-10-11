/**
 * 新建 / 编辑提示词的右侧抽屉。每次打开由父组件换一个 key，表单状态从头开始。
 */
import {
  Alert,
  Button,
  Combobox,
  Drawer,
  Field,
  Input,
  Switch,
  Textarea,
} from "@endfield-ui/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from "react";
import type { AdminModel, AdminPrompt } from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import {
  emptyPromptForm,
  modelOptionLabel,
  PROMPT_CONTENT_MAX,
  promptToForm,
  validatePromptForm,
  type PromptField,
  type PromptFormValues,
} from "./prompt-form";
import { errorMessage } from "./ui";

const FIELD_ORDER: readonly PromptField[] = ["title", "content", "sortOrder"];

export interface PromptEditorProps {
  open: boolean;
  /** 要编辑的提示词；null 表示新建 */
  prompt: AdminPrompt | null;
  /** 全部模型（给"应用到模型"用）；还没取到时是 undefined */
  models: AdminModel[] | undefined;
  modelsLoading: boolean;
  modelsError: Error | undefined;
  onRetryModels: () => void;
  onOpenChange: (open: boolean) => void;
  onSaved: (prompt: AdminPrompt, created: boolean) => void;
}

export function PromptEditor({
  open,
  prompt,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  onOpenChange,
  onSaved,
}: PromptEditorProps) {
  const [values, setValues] = useState<PromptFormValues>(() =>
    prompt ? promptToForm(prompt) : emptyPromptForm(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<PromptField>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const formId = `${baseId}-form`;
  const fieldId = (field: PromptField) => `${baseId}-${field}`;

  const options = useMemo(
    () =>
      (models ?? []).map((model) => ({
        value: String(model.id),
        label: modelOptionLabel(model),
        // 打模型 ID 也能搜到（显示名和 ID 不一样时）
        keywords: [model.model],
      })),
    [models],
  );
  const knownModelIds = useMemo(
    () => (models ? new Set(models.map((model) => model.id)) : null),
    [models],
  );

  const { errors, input } = validatePromptForm(values, { knownModelIds });
  const errorFor = (field: PromptField) =>
    submitted || touched.has(field) ? errors[field] : undefined;
  const touch = (field: PromptField) =>
    setTouched((previous) =>
      previous.has(field) ? previous : new Set(previous).add(field),
    );
  const set = <K extends keyof PromptFormValues>(
    key: K,
    value: PromptFormValues[K],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  useEffect(() => {
    if (serverError) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [serverError]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (!input) {
      const first = FIELD_ORDER.find((field) => errors[field]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      const saved = prompt
        ? await adminApi.updatePrompt(prompt.id, input)
        : await adminApi.createPrompt(input);
      onSaved(saved, prompt === null);
    } catch (error) {
      setServerError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  let modelsHelp =
    "选中的模型每轮检测都会测这条提示词。也可以在“模型”页里给模型分配提示词。";
  if (!models && modelsError) {
    modelsHelp = `模型列表没能加载（${modelsError.message}），这次保存不会改动分配关系。`;
  } else if (models && models.length === 0) {
    modelsHelp = "还没有模型。先到“模型”页添加模型，再回来分配。";
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
      size="lg"
      title={prompt ? `编辑提示词：${prompt.title}` : "新建提示词"}
      footer={
        <>
          <Button
            variant="light"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={saving}
            loadingText="正在保存"
          >
            {prompt ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-6"
      >
        {serverError && (
          <Alert ref={alertRef} tone="danger" title="没能保存">
            {serverError}
          </Alert>
        )}

        <Field
          label="标题"
          required
          controlId={fieldId("title")}
          error={errorFor("title")}
          help="前台的页签名就是它，短一点好认，比如“小数比较”。"
        >
          <Input
            value={values.title}
            autoComplete="off"
            onChange={(event) => set("title", event.target.value)}
            onBlur={() => touch("title")}
          />
        </Field>

        <Field
          label="内容"
          required
          controlId={fieldId("content")}
          error={errorFor("content")}
          help="原样发给模型。想看模型做网页，就在提示词里写明“只输出完整的 HTML 代码”，前台会直接显示网页的样子。"
        >
          <Textarea
            rows={12}
            showCount
            maxLength={PROMPT_CONTENT_MAX}
            value={values.content}
            onChange={(event) => set("content", event.target.value)}
            onBlur={() => touch("content")}
          />
        </Field>

        <Field label="应用到模型" help={modelsHelp}>
          <div className="flex flex-col gap-2">
            <Combobox
              multiple
              items={options}
              value={values.modelIds}
              onValueChange={(next) => set("modelIds", next)}
              loading={modelsLoading && !models}
              disabled={!models}
              placeholder={models ? "输入渠道名或模型名查找" : "正在加载模型…"}
              emptyText="没有匹配的模型"
            />
            {!models && modelsError && (
              <Button
                variant="text"
                size="sm"
                className="self-start"
                loading={modelsLoading}
                onClick={onRetryModels}
              >
                重新加载模型列表
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="排序"
          controlId={fieldId("sortOrder")}
          error={errorFor("sortOrder")}
          help="数字小的排在前面：同一个模型按这个顺序依次检测，前台的页签也按它排。"
        >
          <Input
            type="number"
            inputMode="numeric"
            step={1}
            className="max-w-40"
            value={values.sortOrder}
            onChange={(event) => set("sortOrder", event.target.value)}
            onBlur={() => touch("sortOrder")}
          />
        </Field>

        <div>
          <Switch
            checked={values.enabled}
            onCheckedChange={(checked) => set("enabled", checked)}
          >
            启用这条提示词
          </Switch>
          <p className="mt-1 text-sm text-ink-secondary">
            停用后不再检测，前台也不再显示它；已有的检测记录保留。
          </p>
        </div>
      </form>
    </Drawer>
  );
}
