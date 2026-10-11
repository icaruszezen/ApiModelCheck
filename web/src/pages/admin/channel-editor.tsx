/**
 * 新建 / 编辑渠道的右侧抽屉。每次打开由父组件换一个 key，表单状态从头开始。
 */
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Field,
  IconButton,
  Input,
  Select,
  Switch,
  Textarea,
} from "@endfield-ui/react";
import { useEffect, useId, useRef, useState, type SubmitEvent } from "react";
import {
  ENDPOINT_META,
  ENDPOINT_TYPES,
  isEndpointType,
} from "../../../../shared/endpoints.ts";
import type { AdminChannel } from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import { EyeIcon } from "../../components/icons";
import {
  channelToForm,
  emptyChannelForm,
  previewRequestUrl,
  validateChannelForm,
  type ChannelField,
  type ChannelFormValues,
} from "./channel-form";
import { errorMessage } from "./ui";

const ENDPOINT_OPTIONS = ENDPOINT_TYPES.map((type) => ({
  value: type,
  label: ENDPOINT_META[type].label,
}));

/** 提交时出错，焦点按这个顺序落到第一个出错的字段上 */
const FIELD_ORDER: readonly ChannelField[] = [
  "name",
  "baseUrl",
  "apiKey",
  "extraHeaders",
  "sortOrder",
];

export interface ChannelEditorProps {
  open: boolean;
  /** 要编辑的渠道；null 表示新建 */
  channel: AdminChannel | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (channel: AdminChannel, created: boolean) => void;
}

export function ChannelEditor({
  open,
  channel,
  onOpenChange,
  onSaved,
}: ChannelEditorProps) {
  const mode = channel ? "edit" : "create";
  const [values, setValues] = useState<ChannelFormValues>(() =>
    channel ? channelToForm(channel) : emptyChannelForm(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<ChannelField>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const formId = `${baseId}-form`;
  const fieldId = (field: ChannelField) => `${baseId}-${field}`;

  const { errors, input } = validateChannelForm(values, mode);
  // 没提交过时，只有离开过的字段才显示错误，免得一打开就满屏红字
  const errorFor = (field: ChannelField) =>
    submitted || touched.has(field) ? errors[field] : undefined;
  const touch = (field: ChannelField) =>
    setTouched((previous) =>
      previous.has(field) ? previous : new Set(previous).add(field),
    );
  const set = <K extends keyof ChannelFormValues>(
    key: K,
    value: ChannelFormValues[K],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  useEffect(() => {
    if (serverError) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [serverError]);

  const meta = ENDPOINT_META[values.endpointType];
  const preview = previewRequestUrl(values.endpointType, values.baseUrl);
  const savedKey = channel?.hasApiKey ? channel.apiKeyMasked : "";

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
      const saved = channel
        ? await adminApi.updateChannel(channel.id, input)
        : await adminApi.createChannel(input);
      onSaved(saved, channel === null);
    } catch (error) {
      setServerError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  let keyPlaceholder = "不需要认证可以留空";
  if (mode === "edit") {
    keyPlaceholder = savedKey
      ? `已保存为 ${savedKey}，留空则保持不变`
      : "还没有设置；不需要认证可以留空";
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        // 保存进行中不让关：关了就看不到保存的结果
        if (!next && saving) return;
        onOpenChange(next);
      }}
      size="lg"
      title={channel ? `编辑渠道：${channel.name}` : "新建渠道"}
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
            {channel ? "保存" : "创建"}
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
          label="名称"
          required
          controlId={fieldId("name")}
          error={errorFor("name")}
          help="只在后台和前台的分组标题里显示，比如“OpenAI 官方”“某某中转”。"
        >
          <Input
            value={values.name}
            autoComplete="off"
            onChange={(event) => set("name", event.target.value)}
            onBlur={() => touch("name")}
          />
        </Field>

        <Field label="端点类型" required help={meta.hint}>
          <Select
            items={ENDPOINT_OPTIONS}
            value={values.endpointType}
            onValueChange={(next) => {
              if (isEndpointType(next)) set("endpointType", next);
            }}
          />
        </Field>

        <Field
          label="基础地址"
          controlId={fieldId("baseUrl")}
          // 地址写错了立刻提示：下面的"实际请求地址"也跟着算不出来
          error={errors.baseUrl}
          help={
            <>
              <span className="block">
                留空则用默认地址。写到域名或版本段都可以，如
                https://example.com/v1。
              </span>
              {preview && (
                <span className="mt-1 block">
                  实际请求地址：
                  <code className="font-mono text-xs break-all text-ink">
                    {preview}
                  </code>
                </span>
              )}
            </>
          }
        >
          <Input
            value={values.baseUrl}
            placeholder={meta.defaultBaseUrl}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => set("baseUrl", event.target.value)}
            onBlur={() => touch("baseUrl")}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Field
            label="API 密钥"
            controlId={fieldId("apiKey")}
            error={errorFor("apiKey")}
            help={
              mode === "edit" && savedKey
                ? `已保存的密钥：${savedKey}。保存后只显示打码的样子。`
                : "保存后只显示打码的样子，不会再完整显示。"
            }
          >
            <Input
              type={showKey ? "text" : "password"}
              name="channel-api-key"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={values.apiKey}
              placeholder={
                values.clearApiKey ? "保存后清除密钥" : keyPlaceholder
              }
              disabled={values.clearApiKey}
              onChange={(event) => set("apiKey", event.target.value)}
              onBlur={() => touch("apiKey")}
              end={
                <IconButton
                  size="sm"
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  pressed={showKey}
                  disabled={values.clearApiKey}
                  onClick={() => setShowKey((value) => !value)}
                >
                  <EyeIcon />
                </IconButton>
              }
            />
          </Field>
          {mode === "edit" && channel?.hasApiKey && (
            <Checkbox
              checked={values.clearApiKey}
              onCheckedChange={(checked) =>
                setValues((previous) => ({
                  ...previous,
                  clearApiKey: checked,
                  apiKey: checked ? "" : previous.apiKey,
                }))
              }
            >
              清除已保存的密钥
            </Checkbox>
          )}
        </div>

        <Field
          label="额外请求头"
          controlId={fieldId("extraHeaders")}
          error={errorFor("extraHeaders")}
          help="JSON 对象，键是请求头名称、值是字符串，会覆盖同名的默认请求头（包括认证头）。留空表示不加。"
        >
          <Textarea
            rows={4}
            className="font-mono text-sm"
            spellCheck={false}
            autoCapitalize="none"
            placeholder={'{"X-Custom": "value"}'}
            value={values.extraHeaders}
            onChange={(event) => set("extraHeaders", event.target.value)}
            onBlur={() => touch("extraHeaders")}
          />
        </Field>

        <Field
          label="排序"
          controlId={fieldId("sortOrder")}
          error={errorFor("sortOrder")}
          help="数字小的排在前面，前台的渠道顺序也按它。"
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
            启用这个渠道
          </Switch>
          <p className="mt-1 text-sm text-ink-secondary">
            停用后，它下面的模型都不再检测，前台也不再显示这个渠道。
          </p>
        </div>
      </form>
    </Drawer>
  );
}
