/**
 * 渠道表单的数据与校验：表单里的值都是字符串（输入框原样），提交前转成 ChannelInput。
 */
import {
  baseUrlIssue,
  buildRequestUrl,
  ENDPOINT_META,
  isValidBaseUrl,
  type EndpointType,
} from "../../../../shared/endpoints.ts";
import type { AdminChannel, ChannelInput } from "../../../../shared/types.ts";
import {
  compactErrors,
  hasErrors,
  parseSortOrder,
  SORT_ORDER_ERROR,
  textError,
  type FieldErrors,
  type FormResult,
} from "./shell-form";

export const CHANNEL_NAME_MAX = 100;
export const BASE_URL_MAX = 500;
export const API_KEY_MAX = 1000;
export const HEADERS_MAX = 30;
export const HEADER_VALUE_MAX = 2000;

/** HTTP 头名称允许的字符（RFC 9110 的 token），与服务端相同 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface ChannelFormValues {
  name: string;
  endpointType: EndpointType;
  baseUrl: string;
  /** 新填的密钥；编辑时留空表示保留原来的 */
  apiKey: string;
  /** 编辑时勾选"清除已保存的密钥" */
  clearApiKey: boolean;
  /** 额外请求头的 JSON 文本，留空表示没有 */
  extraHeaders: string;
  sortOrder: string;
  enabled: boolean;
}

export type ChannelField =
  | "name"
  | "baseUrl"
  | "apiKey"
  | "extraHeaders"
  | "sortOrder";

export type ChannelFormErrors = FieldErrors<ChannelField>;

export function emptyChannelForm(): ChannelFormValues {
  return {
    name: "",
    endpointType: "openai-chat",
    baseUrl: "",
    apiKey: "",
    clearApiKey: false,
    extraHeaders: "",
    sortOrder: "0",
    enabled: true,
  };
}

/** 请求头对象 → 文本框里的 JSON；没有请求头时是空串 */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.keys(headers).length === 0
    ? ""
    : JSON.stringify(headers, null, 2);
}

export function channelToForm(channel: AdminChannel): ChannelFormValues {
  return {
    name: channel.name,
    endpointType: channel.endpointType,
    baseUrl: channel.baseUrl,
    // 密钥从不回传明文，编辑时输入框总是空的
    apiKey: "",
    clearApiKey: false,
    extraHeaders: formatHeaders(channel.extraHeaders),
    sortOrder: String(channel.sortOrder),
    enabled: channel.enabled,
  };
}

export type HeadersParseResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

/**
 * 解析额外请求头的 JSON 文本。规则和服务端一致：最多 30 个，名称是 HTTP token、
 * 不区分大小写不能重复，值不能含换行、不超过 2000 字。名称和值都去掉首尾空白。
 */
export function parseExtraHeaders(text: string): HeadersParseResult {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        '不是合法的 JSON，请写成 {"名称": "值"} 的形式（键和值都要用双引号）',
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: '额外请求头必须是 {"名称": "值"} 形式的 JSON 对象',
    };
  }
  const entries = Object.entries(parsed);
  if (entries.length > HEADERS_MAX) {
    return { ok: false, error: `额外请求头最多 ${HEADERS_MAX} 个` };
  }
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!name) return { ok: false, error: "额外请求头的名称不能为空" };
    if (typeof rawValue !== "string") {
      return { ok: false, error: `请求头"${name}"的值必须是字符串` };
    }
    const value = rawValue.trim();
    if (!HEADER_NAME.test(name)) {
      return { ok: false, error: `请求头名称"${name}"含有不允许的字符` };
    }
    if (seen.has(name.toLowerCase())) {
      return { ok: false, error: `请求头"${name}"重复了` };
    }
    if (/[\r\n\0]/.test(value)) {
      return { ok: false, error: `请求头"${name}"的值不能包含换行` };
    }
    if (value.length > HEADER_VALUE_MAX) {
      return {
        ok: false,
        error: `请求头"${name}"的值不能超过 ${HEADER_VALUE_MAX} 个字符`,
      };
    }
    seen.add(name.toLowerCase());
    out.push([name, value]);
  }
  // fromEntries 按"自有属性"写入：名字叫 __proto__ 的头也不会改到原型上
  return { ok: true, value: Object.fromEntries(out) };
}

/** 基础地址的错误；空串合法（用默认地址）。具体哪里不对与服务端同一套说法 */
export function baseUrlError(baseUrl: string): string | undefined {
  if (baseUrl.trim().length > BASE_URL_MAX) {
    return `基础地址不能超过 ${BASE_URL_MAX} 个字符`;
  }
  return baseUrlIssue(baseUrl) ?? undefined;
}

/**
 * 表单里预览的"实际请求地址"。模型传空串：Gemini 的地址里会显示成可读的"{模型}"，
 * 其余类型的地址里没有模型名。地址无效时返回 null。
 */
export function previewRequestUrl(
  type: EndpointType,
  baseUrl: string,
): string | null {
  if (!isValidBaseUrl(baseUrl)) return null;
  try {
    return buildRequestUrl(type, baseUrl, "", false);
  } catch {
    return null;
  }
}

/** 列表里显示的基础地址：没填时是该类型的默认地址 */
export function effectiveBaseUrl(
  channel: Pick<AdminChannel, "endpointType" | "baseUrl">,
): { url: string; isDefault: boolean } {
  const url = channel.baseUrl.trim();
  return url
    ? { url, isDefault: false }
    : {
        url: ENDPOINT_META[channel.endpointType].defaultBaseUrl,
        isDefault: true,
      };
}

export function validateChannelForm(
  values: ChannelFormValues,
  mode: "create" | "edit",
): FormResult<ChannelField, ChannelInput> {
  const errors: ChannelFormErrors = {};
  errors.name = textError("名称", values.name, CHANNEL_NAME_MAX, true);
  errors.baseUrl = baseUrlError(values.baseUrl);
  const apiKey = values.apiKey.trim();
  if (!(mode === "edit" && values.clearApiKey)) {
    errors.apiKey = textError("API 密钥", apiKey, API_KEY_MAX, false);
  }
  const headers = parseExtraHeaders(values.extraHeaders);
  if (!headers.ok) errors.extraHeaders = headers.error;
  const sortOrder = parseSortOrder(values.sortOrder);
  if (sortOrder === null) errors.sortOrder = SORT_ORDER_ERROR;

  if (hasErrors(errors) || !headers.ok || sortOrder === null) {
    return { errors: compactErrors(errors), input: null };
  }

  const input: ChannelInput = {
    name: values.name.trim(),
    endpointType: values.endpointType,
    baseUrl: values.baseUrl.trim(),
    extraHeaders: headers.value,
    enabled: values.enabled,
    sortOrder,
  };
  if (mode === "create") {
    // 新建时空串表示不带认证
    input.apiKey = apiKey;
  } else if (values.clearApiKey) {
    input.apiKey = null;
  } else if (apiKey !== "") {
    input.apiKey = apiKey;
  }
  // 编辑且没填新密钥：不传 apiKey，服务器保留原来的
  return { errors: {}, input };
}

/** 列表里直接拨"启用"开关时提交的请求体：其余字段照旧，密钥不动 */
export function channelToggleInput(
  channel: AdminChannel,
  enabled: boolean,
): ChannelInput {
  return {
    name: channel.name,
    endpointType: channel.endpointType,
    baseUrl: channel.baseUrl,
    extraHeaders: channel.extraHeaders,
    enabled,
    sortOrder: channel.sortOrder,
  };
}
