/**
 * 后台表单共用的小工具：整数字段的解析、错误表的类型。
 * 规则与措辞照抄服务端（server/validation.ts），前端先拦一道，提交后服务器再兜底。
 */

/** 一张表单的字段级错误：只有出错的字段才有值 */
export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** 表单校验的结果：通过时 input 是可以直接提交的请求体，否则为 null */
export interface FormResult<K extends string, T> {
  errors: FieldErrors<K>;
  input: T | null;
}

export function hasErrors(errors: Partial<Record<string, string>>): boolean {
  return Object.values(errors).some((message) => Boolean(message));
}

/** 去掉没有出错的字段（值为 undefined 或空串的） */
export function compactErrors<K extends string>(
  errors: FieldErrors<K>,
): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const key of Object.keys(errors) as K[]) {
    const message = errors[key];
    if (message) out[key] = message;
  }
  return out;
}

/**
 * 整数文本 → 数字；不是整数（含小数、科学计数法、空串）或超出范围时返回 null。
 * 允许首尾空白和正负号。
 */
export function parseIntInRange(
  text: string,
  min: number,
  max: number,
): number | null {
  const raw = text.trim();
  if (!/^[+-]?\d{1,16}$/.test(raw)) return null;
  // "-0" 也当 0，免得提交出一个 -0
  const value = Number(raw) || 0;
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** "保留条数必须是 1 到 1000 之间的整数"（与服务端同一句） */
export function rangeMessage(label: string, min: number, max: number): string {
  return `${label}必须是 ${min} 到 ${max} 之间的整数`;
}

export const SORT_ORDER_MIN = -1_000_000;
export const SORT_ORDER_MAX = 1_000_000;
export const SORT_ORDER_ERROR = rangeMessage(
  "排序值",
  SORT_ORDER_MIN,
  SORT_ORDER_MAX,
);

/** 排序值：留空按 0 算（服务端缺省也是 0） */
export function parseSortOrder(text: string): number | null {
  if (text.trim() === "") return 0;
  return parseIntInRange(text, SORT_ORDER_MIN, SORT_ORDER_MAX);
}

/** 文本字段的长度校验（先去首尾空白），返回错误信息或 undefined */
export function textError(
  label: string,
  value: string,
  max: number,
  required: boolean,
): string | undefined {
  const trimmed = value.trim();
  if (required && trimmed === "") return `${label}不能为空`;
  if (trimmed.length > max) return `${label}不能超过 ${max} 个字符`;
  return undefined;
}
