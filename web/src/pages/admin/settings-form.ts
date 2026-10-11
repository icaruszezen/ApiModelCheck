/**
 * 站点设置表单的数据与校验。范围和措辞与服务端一致。
 */
import type { Settings } from "../../../../shared/types.ts";
import {
  compactErrors,
  hasErrors,
  parseIntInRange,
  rangeMessage,
  textError,
  type FieldErrors,
  type FormResult,
} from "./shell-form";

export const SITE_TITLE_MAX = 100;
export const SITE_DESCRIPTION_MAX = 500;
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 1000;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 20;

export interface SettingsFormValues {
  siteTitle: string;
  siteDescription: string;
  retentionPerCheck: string;
  maxConcurrency: string;
}

export type SettingsField = keyof SettingsFormValues;

export type SettingsFormErrors = FieldErrors<SettingsField>;

export function settingsToForm(settings: Settings): SettingsFormValues {
  return {
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    retentionPerCheck: String(settings.retentionPerCheck),
    maxConcurrency: String(settings.maxConcurrency),
  };
}

export function validateSettingsForm(
  values: SettingsFormValues,
): FormResult<SettingsField, Settings> {
  const errors: SettingsFormErrors = {};
  errors.siteTitle = textError(
    "站点标题",
    values.siteTitle,
    SITE_TITLE_MAX,
    true,
  );
  errors.siteDescription = textError(
    "站点说明",
    values.siteDescription,
    SITE_DESCRIPTION_MAX,
    false,
  );
  const retention = parseIntInRange(
    values.retentionPerCheck,
    RETENTION_MIN,
    RETENTION_MAX,
  );
  if (retention === null) {
    errors.retentionPerCheck = rangeMessage(
      "保留条数",
      RETENTION_MIN,
      RETENTION_MAX,
    );
  }
  const concurrency = parseIntInRange(
    values.maxConcurrency,
    CONCURRENCY_MIN,
    CONCURRENCY_MAX,
  );
  if (concurrency === null) {
    errors.maxConcurrency = rangeMessage(
      "同时检测数",
      CONCURRENCY_MIN,
      CONCURRENCY_MAX,
    );
  }
  if (hasErrors(errors) || retention === null || concurrency === null) {
    return { errors: compactErrors(errors), input: null };
  }
  return {
    errors: {},
    input: {
      siteTitle: values.siteTitle.trim(),
      siteDescription: values.siteDescription.trim(),
      retentionPerCheck: retention,
      maxConcurrency: concurrency,
    },
  };
}

/** 表单和上次保存的值是否不同（按输入框里的文字比） */
export function isSettingsDirty(
  values: SettingsFormValues,
  saved: Settings,
): boolean {
  const base = settingsToForm(saved);
  return (Object.keys(base) as SettingsField[]).some(
    (key) => values[key] !== base[key],
  );
}
