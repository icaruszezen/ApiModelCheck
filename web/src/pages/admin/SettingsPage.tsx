/**
 * 设置：前台展示的文字、检测的全局参数（要点"保存"才生效），以及当前账号。
 */
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelRow,
  PanelRows,
  SectionTitle,
  Skeleton,
  Textarea,
  useToast,
} from "@endfield-ui/react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";
import type { Settings } from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import { LogoutIcon } from "../../components/icons";
import { useAsync } from "../../lib/use-async";
import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  isSettingsDirty,
  RETENTION_MAX,
  RETENTION_MIN,
  SITE_DESCRIPTION_MAX,
  settingsToForm,
  validateSettingsForm,
  type SettingsField,
  type SettingsFormValues,
} from "./settings-form";
import { useAdminSession, useSaveError } from "./shell-session";
import { AdminPage } from "./ui";

const FIELD_ORDER: readonly SettingsField[] = [
  "siteTitle",
  "siteDescription",
  "retentionPerCheck",
  "maxConcurrency",
];

export function SettingsPage() {
  const settings = useAsync(() => adminApi.settings(), []);

  let form: ReactNode;
  if (settings.data) {
    form = <SettingsForm initial={settings.data} />;
  } else if (settings.error) {
    form = (
      <EmptyState
        title="设置没能加载"
        description={settings.error.message}
        action={
          <Button
            loading={settings.loading}
            onClick={() => void settings.reload()}
          >
            重试
          </Button>
        }
      />
    );
  } else {
    form = (
      <div
        aria-busy="true"
        aria-label="正在加载设置"
        className="flex flex-col gap-6"
      >
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16" />
        <Skeleton className="h-24" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  return (
    <AdminPage
      title="设置"
      meta="// SETTINGS"
      description="前台页面上的文字，以及检测的全局参数。"
    >
      <div className="flex max-w-3xl flex-col gap-12">
        {form}
        <AccountSection />
      </div>
    </AdminPage>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const toast = useToast();
  // 上次保存（或载入）的值："放弃修改"回到它，有没有改动也和它比
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<SettingsFormValues>(() =>
    settingsToForm(initial),
  );
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<SettingsField>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  // 因为登录过期没保存上的提示，重新登录后自己收起
  const saveError = useSaveError();
  const serverError = saveError.message;
  const alertRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const fieldId = (field: SettingsField) => `${baseId}-${field}`;

  const { errors, input } = validateSettingsForm(values);
  const dirty = isSettingsDirty(values, saved);
  const errorFor = (field: SettingsField) =>
    submitted || touched.has(field) ? errors[field] : undefined;
  const touch = (field: SettingsField) =>
    setTouched((previous) =>
      previous.has(field) ? previous : new Set(previous).add(field),
    );
  const set = (key: SettingsField, value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));

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
    saveError.clear();
    try {
      const next = await adminApi.updateSettings(input);
      setSaved(next);
      // 用服务器回来的值（去过空白的）刷新表单
      setValues(settingsToForm(next));
      setSubmitted(false);
      setTouched(new Set());
      toast({ message: "设置已保存", tone: "success" });
    } catch (error) {
      saveError.fail(error);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setValues(settingsToForm(saved));
    setSubmitted(false);
    setTouched(new Set());
    saveError.clear();
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-10">
      {serverError && (
        <Alert ref={alertRef} tone="danger" title="没能保存">
          {serverError}
        </Alert>
      )}

      <section className="flex flex-col gap-6">
        <SectionTitle variant="plain">前台展示</SectionTitle>
        <Field
          label="站点标题"
          required
          controlId={fieldId("siteTitle")}
          error={errorFor("siteTitle")}
          help="显示在检测页的顶部和浏览器标签上。"
        >
          <Input
            value={values.siteTitle}
            autoComplete="off"
            onChange={(event) => set("siteTitle", event.target.value)}
            onBlur={() => touch("siteTitle")}
          />
        </Field>
        <Field
          label="站点说明"
          controlId={fieldId("siteDescription")}
          error={errorFor("siteDescription")}
          help="标题下面的一段话，告诉访客这个页面在做什么。可以留空。"
        >
          <Textarea
            rows={3}
            showCount
            maxLength={SITE_DESCRIPTION_MAX}
            value={values.siteDescription}
            onChange={(event) => set("siteDescription", event.target.value)}
            onBlur={() => touch("siteDescription")}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-6">
        <SectionTitle variant="plain">检测</SectionTitle>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field
            label="每项保留的记录数"
            required
            controlId={fieldId("retentionPerCheck")}
            error={errorFor("retentionPerCheck")}
            help={`每个“模型 × 提示词”只保留最近这么多条检测记录，更早的自动删除。${RETENTION_MIN} – ${RETENTION_MAX}。`}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={RETENTION_MIN}
              max={RETENTION_MAX}
              step={1}
              end="条"
              value={values.retentionPerCheck}
              onChange={(event) => set("retentionPerCheck", event.target.value)}
              onBlur={() => touch("retentionPerCheck")}
            />
          </Field>
          <Field
            label="同时检测的模型数"
            required
            controlId={fieldId("maxConcurrency")}
            error={errorFor("maxConcurrency")}
            help={`同一时间最多几个模型在检测；同一个模型的几条提示词总是一条接一条地测。${CONCURRENCY_MIN} – ${CONCURRENCY_MAX}。`}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={CONCURRENCY_MIN}
              max={CONCURRENCY_MAX}
              step={1}
              end="个"
              value={values.maxConcurrency}
              onChange={(event) => set("maxConcurrency", event.target.value)}
              onBlur={() => touch("maxConcurrency")}
            />
          </Field>
        </div>
        <p className="text-sm text-ink-secondary">
          检测间隔、超时时间和流式开关是按模型分别设置的，在“模型”页里改。
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-6">
        {dirty && !saving && (
          <span className="mr-auto text-sm text-ink-secondary" role="status">
            有未保存的修改
          </span>
        )}
        <Button variant="light" disabled={!dirty || saving} onClick={reset}>
          放弃修改
        </Button>
        <Button
          type="submit"
          disabled={!dirty}
          loading={saving}
          loadingText="正在保存"
        >
          保存设置
        </Button>
      </div>
    </form>
  );
}

function AccountSection() {
  const { username, logout, loggingOut } = useAdminSession();
  return (
    <section className="flex flex-col gap-6">
      <SectionTitle variant="plain">账号</SectionTitle>
      <Panel>
        <PanelRows>
          <PanelRow label="当前账号">{username}</PanelRow>
          <PanelRow label="用户名来自">ADMIN_USERNAME</PanelRow>
          <PanelRow label="密码来自">ADMIN_PASSWORD</PanelRow>
        </PanelRows>
      </Panel>
      <p className="text-sm text-ink-secondary">
        {
          "后台的用户名和密码由服务器的环境变量设置，这里不能修改。改了密码并重启服务后，所有已登录的会话都会失效，需要重新登录。"
        }
      </p>
      <div>
        <Button
          iconStart={<LogoutIcon />}
          loading={loggingOut}
          loadingText="正在退出"
          onClick={() => void logout()}
        >
          退出登录
        </Button>
      </div>
    </section>
  );
}
