/**
 * 模型表单的纯逻辑：检测间隔的单位换算、表单校验、请求体组装。
 * 校验规则与服务端（server/validation.ts 的 modelSchema）一致，提示语也尽量相同，
 * 这样大部分错误在提交前就能落到具体字段上。
 */
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
  ModelInput,
} from "../../../../shared/types.ts";

export type IntervalUnit = "minute" | "hour" | "day";

export const INTERVAL_UNITS: readonly {
  value: IntervalUnit;
  label: string;
  minutes: number;
}[] = [
  { value: "minute", label: "分钟", minutes: 1 },
  { value: "hour", label: "小时", minutes: 60 },
  { value: "day", label: "天", minutes: 1440 },
];

export const MODEL_LIMITS = {
  modelLength: 200,
  displayNameLength: 100,
  timeoutMin: 5,
  timeoutMax: 3600,
  intervalMin: 1,
  /** 一周 */
  intervalMax: 10080,
  maxTokensMin: 1,
  maxTokensMax: 1_000_000,
  temperatureMin: 0,
  temperatureMax: 2,
  sortOrderMin: -1_000_000,
  sortOrderMax: 1_000_000,
} as const;

export const MODEL_DEFAULTS = {
  stream: true,
  timeoutSeconds: 120,
  intervalMinutes: 60,
} as const;

export function isIntervalUnit(value: string): value is IntervalUnit {
  return INTERVAL_UNITS.some((unit) => unit.value === value);
}

export function unitMinutes(unit: IntervalUnit): number {
  return INTERVAL_UNITS.find((item) => item.value === unit)?.minutes ?? 1;
}

/** 把分钟数拆成"数字 + 单位"，取能整除的最大单位：1440 → 1 天，90 → 90 分钟 */
export function splitInterval(minutes: number): {
  value: number;
  unit: IntervalUnit;
} {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return { value: minutes, unit: "minute" };
  }
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: "day" };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: "hour" };
  return { value: minutes, unit: "minute" };
}

export function toMinutes(value: number, unit: IntervalUnit): number {
  return value * unitMinutes(unit);
}

/** 表单状态。数字先存成字符串：允许暂时为空或写到一半，提交时再统一校验 */
export interface ModelFormState {
  /** "" 表示还没选 */
  channelId: string;
  model: string;
  displayName: string;
  promptIds: number[];
  stream: boolean;
  timeoutSeconds: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  /** "" 表示不传 */
  maxTokens: string;
  /** "" 表示不传 */
  temperature: string;
  sortOrder: string;
  enabled: boolean;
}

export type ModelFormField =
  | "channelId"
  | "model"
  | "displayName"
  | "timeoutSeconds"
  | "interval"
  | "maxTokens"
  | "temperature"
  | "sortOrder";

export type ModelFormErrors = Partial<Record<ModelFormField, string>>;

/** 字段在表单上的先后顺序：提交失败时把焦点移到第一个出错的字段 */
export const MODEL_FORM_FIELDS: readonly ModelFormField[] = [
  "channelId",
  "model",
  "displayName",
  "timeoutSeconds",
  "interval",
  "maxTokens",
  "temperature",
  "sortOrder",
];

/** 新建时的默认值：流式、超时 120 秒、每 60 分钟；选中第一个渠道（优先启用的）和所有启用的提示词 */
export function newModelForm(
  channels: readonly AdminChannel[],
  prompts: readonly AdminPrompt[],
): ModelFormState {
  const channel = channels.find((item) => item.enabled) ?? channels[0];
  const interval = splitInterval(MODEL_DEFAULTS.intervalMinutes);
  return {
    channelId: channel ? String(channel.id) : "",
    model: "",
    displayName: "",
    promptIds: prompts
      .filter((prompt) => prompt.enabled)
      .map((prompt) => prompt.id),
    stream: MODEL_DEFAULTS.stream,
    timeoutSeconds: String(MODEL_DEFAULTS.timeoutSeconds),
    intervalValue: String(interval.value),
    intervalUnit: interval.unit,
    maxTokens: "",
    temperature: "",
    sortOrder: "0",
    enabled: true,
  };
}

export function modelToForm(model: AdminModel): ModelFormState {
  const interval = splitInterval(model.intervalMinutes);
  return {
    channelId: String(model.channelId),
    model: model.model,
    displayName: model.displayName,
    promptIds: [...model.promptIds],
    stream: model.stream,
    timeoutSeconds: String(model.timeoutSeconds),
    intervalValue: String(interval.value),
    intervalUnit: interval.unit,
    maxTokens: model.maxTokens === null ? "" : String(model.maxTokens),
    temperature: model.temperature === null ? "" : String(model.temperature),
    sortOrder: String(model.sortOrder),
    enabled: model.enabled,
  };
}

/** 现有模型的全部字段，改其中几项：列表里的启用开关要 PUT 完整的请求体 */
export function modelToInput(
  model: AdminModel,
  patch: Partial<ModelInput> = {},
): ModelInput {
  return {
    channelId: model.channelId,
    model: model.model,
    displayName: model.displayName,
    stream: model.stream,
    timeoutSeconds: model.timeoutSeconds,
    intervalMinutes: model.intervalMinutes,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
    enabled: model.enabled,
    sortOrder: model.sortOrder,
    promptIds: [...model.promptIds],
    ...patch,
  };
}

/** 中文输入法下容易打出全角数字、小数点和负号，先换成半角 */
export function normalizeNumberText(text: string): string {
  return text
    .trim()
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/[．。]/g, ".")
    .replace(/[－−]/g, "-")
    .replace(/＋/g, "+");
}

/** 严格的整数解析："12" → 12；"12.5"、"1e3"、"abc"、"" → NaN */
export function parseInteger(text: string): number {
  const normalized = normalizeNumberText(text);
  return /^[+-]?\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/** 严格的小数解析："0.7"、".5"、"1" → 数字；其余 → NaN */
export function parseDecimal(text: string): number {
  const normalized = normalizeNumberText(text);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
    ? Number(normalized)
    : Number.NaN;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** 检测间隔换算成分钟；不是正整数或超出 1 分钟 – 7 天时给出错误 */
function intervalMinutesOf(
  form: ModelFormState,
): { ok: true; minutes: number } | { ok: false; error: string } {
  if (form.intervalValue.trim() === "") {
    return { ok: false, error: "请填写检测间隔" };
  }
  const value = parseInteger(form.intervalValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: "检测间隔必须是正整数" };
  }
  const minutes = toMinutes(value, form.intervalUnit);
  if (
    minutes < MODEL_LIMITS.intervalMin ||
    minutes > MODEL_LIMITS.intervalMax
  ) {
    return { ok: false, error: "检测间隔必须在 1 分钟到 7 天之间" };
  }
  return { ok: true, minutes };
}

export function validateModelForm(form: ModelFormState): ModelFormErrors {
  const errors: ModelFormErrors = {};

  const channelId = parseInteger(form.channelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    errors.channelId = "请选择渠道";
  }

  const model = form.model.trim();
  if (model === "") {
    errors.model = "模型 ID 不能为空";
  } else if (model.length > MODEL_LIMITS.modelLength) {
    errors.model = `模型 ID 不能超过 ${MODEL_LIMITS.modelLength} 个字符`;
  }

  if (form.displayName.trim().length > MODEL_LIMITS.displayNameLength) {
    errors.displayName = `显示名不能超过 ${MODEL_LIMITS.displayNameLength} 个字符`;
  }

  if (form.timeoutSeconds.trim() === "") {
    errors.timeoutSeconds = "请填写超时时间";
  } else if (
    !inRange(
      parseInteger(form.timeoutSeconds),
      MODEL_LIMITS.timeoutMin,
      MODEL_LIMITS.timeoutMax,
    )
  ) {
    errors.timeoutSeconds = `超时时间必须是 ${MODEL_LIMITS.timeoutMin} 到 ${MODEL_LIMITS.timeoutMax} 之间的整数`;
  }

  const interval = intervalMinutesOf(form);
  if (!interval.ok) errors.interval = interval.error;

  if (
    form.maxTokens.trim() !== "" &&
    !inRange(
      parseInteger(form.maxTokens),
      MODEL_LIMITS.maxTokensMin,
      MODEL_LIMITS.maxTokensMax,
    )
  ) {
    errors.maxTokens = `最大输出 tokens 必须是 ${MODEL_LIMITS.maxTokensMin} 到 ${MODEL_LIMITS.maxTokensMax} 之间的整数`;
  }

  if (form.temperature.trim() !== "") {
    const temperature = parseDecimal(form.temperature);
    if (
      !Number.isFinite(temperature) ||
      temperature < MODEL_LIMITS.temperatureMin ||
      temperature > MODEL_LIMITS.temperatureMax
    ) {
      errors.temperature = "温度必须是 0 到 2 之间的数字";
    }
  }

  // 排序值留空按 0 算，和服务端的默认值一致
  if (
    form.sortOrder.trim() !== "" &&
    !inRange(
      parseInteger(form.sortOrder),
      MODEL_LIMITS.sortOrderMin,
      MODEL_LIMITS.sortOrderMax,
    )
  ) {
    errors.sortOrder = `排序值必须是 ${MODEL_LIMITS.sortOrderMin} 到 ${MODEL_LIMITS.sortOrderMax} 之间的整数`;
  }

  return errors;
}

export function firstErrorField(
  errors: ModelFormErrors,
): ModelFormField | undefined {
  return MODEL_FORM_FIELDS.find((field) => errors[field] !== undefined);
}

/** 校验通过时组装请求体；否则返回各字段的错误 */
export function buildModelInput(
  form: ModelFormState,
): { ok: true; input: ModelInput } | { ok: false; errors: ModelFormErrors } {
  const errors = validateModelForm(form);
  const interval = intervalMinutesOf(form);
  if (Object.keys(errors).length > 0 || !interval.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      channelId: parseInteger(form.channelId),
      model: form.model.trim(),
      displayName: form.displayName.trim(),
      stream: form.stream,
      timeoutSeconds: parseInteger(form.timeoutSeconds),
      intervalMinutes: interval.minutes,
      maxTokens:
        form.maxTokens.trim() === "" ? null : parseInteger(form.maxTokens),
      temperature:
        form.temperature.trim() === "" ? null : parseDecimal(form.temperature),
      enabled: form.enabled,
      sortOrder:
        form.sortOrder.trim() === "" ? 0 : parseInteger(form.sortOrder),
      promptIds: [...new Set(form.promptIds)],
    },
  };
}
