/**
 * 请求体与查询参数的校验。错误信息是给管理员看的中文短句，说清哪个字段、什么问题。
 * 字符串字段先去首尾空白（提示词内容除外，只判断是否全是空白）。
 */
import { z } from "zod";
import { ENDPOINT_TYPES, baseUrlIssue } from "../shared/endpoints.ts";
import type {
  ChannelInput,
  LoginInput,
  ModelInput,
  PromptInput,
  ResultStatus,
  RunInput,
  Settings,
} from "../shared/types.ts";

export type Validated<T> = { ok: true; data: T } | { ok: false; error: string };

const BODY_ERROR = "请求体必须是 JSON 对象";

/** 用 schema 校验，失败时只取第一条错误信息 */
export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
): Validated<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? "请求参数不正确",
  };
}

/** 标签以英文或数字结尾时补一个空格再接中文，如"模型 ID 不能为空" */
function phrase(label: string, rest: string): string {
  return /[A-Za-z0-9]$/.test(label) ? `${label} ${rest}` : `${label}${rest}`;
}

function text(
  label: string,
  max: number,
  options: { required?: boolean } = {},
) {
  const required = options.required ?? true;
  let schema = z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? phrase(label, "不能为空")
          : phrase(label, "必须是字符串"),
    })
    .trim();
  if (required) schema = schema.min(1, { error: phrase(label, "不能为空") });
  return schema.max(max, { error: phrase(label, `不能超过 ${max} 个字符`) });
}

function intRange(label: string, min: number, max: number) {
  const message = phrase(label, `必须是 ${min} 到 ${max} 之间的整数`);
  return z
    .number({ error: message })
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message });
}

function bool(label: string) {
  return z.boolean({ error: phrase(label, "必须是 true 或 false") });
}

function idList(label: string) {
  return z
    .array(
      z
        .number({ error: `${label} id 必须是正整数` })
        .int({ error: `${label} id 必须是正整数` })
        .positive({ error: `${label} id 必须是正整数` }),
      { error: `${label}列表格式不对` },
    )
    .max(1000, { error: `${label}最多 1000 个` })
    .transform((ids) => [...new Set(ids)]);
}

const sortOrder = intRange("排序值", -1_000_000, 1_000_000).default(0);

/* ------------------------------ 认证 ------------------------------ */

export const loginSchema: z.ZodType<LoginInput> = z.object(
  {
    username: z
      .string({ error: "请输入用户名" })
      .max(200, { error: "用户名太长" }),
    password: z
      .string({ error: "请输入密码" })
      .max(1000, { error: "密码太长" }),
  },
  { error: BODY_ERROR },
);

/* ------------------------------ 渠道 ------------------------------ */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADERS = 30;

const extraHeaders = z
  .record(z.string(), z.string({ error: "额外请求头的值必须是字符串" }), {
    error: "额外请求头必须是 { 名称: 值 } 形式的对象",
  })
  .default({})
  .transform((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length > MAX_HEADERS) {
      ctx.issues.push({
        code: "custom",
        message: `额外请求头最多 ${MAX_HEADERS} 个`,
        input: value,
      });
      return z.NEVER;
    }
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const [rawName, rawValue] of entries) {
      const name = rawName.trim();
      const headerValue = rawValue.trim();
      let message: string | null = null;
      if (!name) message = "额外请求头的名称不能为空";
      else if (!HEADER_NAME.test(name))
        message = `请求头名称"${name}"含有不允许的字符`;
      else if (seen.has(name.toLowerCase())) message = `请求头"${name}"重复了`;
      else if (/[\r\n\0]/.test(headerValue))
        message = `请求头"${name}"的值不能包含换行`;
      else if (headerValue.length > 2000)
        message = `请求头"${name}"的值不能超过 2000 个字符`;
      if (message) {
        ctx.issues.push({ code: "custom", message, input: value });
        return z.NEVER;
      }
      seen.add(name.toLowerCase());
      out[name] = headerValue;
    }
    return out;
  });

export const channelSchema: z.ZodType<ChannelInput> = z.object(
  {
    name: text("名称", 100),
    endpointType: z.enum(ENDPOINT_TYPES, { error: "端点类型无效" }),
    baseUrl: text("基础地址", 500, { required: false })
      .default("")
      .superRefine((value, ctx) => {
        // 和后台表单用同一套规则与提示（如地址里不能带用户名密码）
        const message = baseUrlIssue(value);
        if (message) ctx.addIssue({ code: "custom", message, input: value });
      }),
    apiKey: text("API 密钥", 1000, { required: false }).nullable().optional(),
    extraHeaders,
    enabled: bool("启用").default(true),
    sortOrder,
  },
  { error: BODY_ERROR },
);

/* ----------------------------- 提示词 ----------------------------- */

export const promptSchema: z.ZodType<PromptInput> = z.object(
  {
    title: text("标题", 100),
    content: z
      .string({
        error: (issue) =>
          issue.input === undefined ? "内容不能为空" : "内容必须是字符串",
      })
      .refine((value) => value.trim() !== "", { error: "内容不能为空" })
      .refine((value) => value.length <= 20000, {
        error: "内容不能超过 20000 个字符",
      }),
    enabled: bool("启用").default(true),
    sortOrder,
    modelIds: idList("模型").optional(),
  },
  { error: BODY_ERROR },
);

/* ------------------------------ 模型 ------------------------------ */

export const modelSchema: z.ZodType<ModelInput> = z.object(
  {
    channelId: z
      .number({ error: "请选择渠道" })
      .int({ error: "请选择渠道" })
      .positive({ error: "请选择渠道" }),
    model: text("模型 ID", 200),
    displayName: text("显示名", 100, { required: false }).default(""),
    stream: bool("流式").default(true),
    timeoutSeconds: intRange("超时时间", 5, 3600).default(120),
    intervalMinutes: intRange("检测间隔", 1, 10080).default(60),
    maxTokens: intRange("最大输出 tokens", 1, 1_000_000)
      .nullable()
      .default(null),
    temperature: z
      .number({ error: "温度必须是 0 到 2 之间的数字" })
      .min(0, { error: "温度必须是 0 到 2 之间的数字" })
      .max(2, { error: "温度必须是 0 到 2 之间的数字" })
      .nullable()
      .default(null),
    enabled: bool("启用").default(true),
    sortOrder,
    promptIds: idList("提示词").default([]),
  },
  { error: BODY_ERROR },
);

export const runSchema: z.ZodType<RunInput> = z.object(
  {
    promptId: z
      .number({ error: "提示词 id 必须是正整数" })
      .int({ error: "提示词 id 必须是正整数" })
      .positive({ error: "提示词 id 必须是正整数" })
      .optional(),
  },
  { error: BODY_ERROR },
);

/* ------------------------------ 设置 ------------------------------ */

/** 只改传了的字段 */
export const settingsSchema: z.ZodType<Partial<Settings>> = z.object(
  {
    siteTitle: text("站点标题", 100).optional(),
    siteDescription: text("站点说明", 500, { required: false }).optional(),
    retentionPerCheck: intRange("保留条数", 1, 1000).optional(),
    maxConcurrency: intRange("同时检测数", 1, 20).optional(),
  },
  { error: BODY_ERROR },
);

/* ---------------------------- 查询参数 ---------------------------- */

/** 路径或查询参数里的正整数 id；不合法返回 null */
export function parseId(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

/**
 * 可选的正整数查询参数：没传（或空串）返回 undefined，不合法返回 null。
 */
export function parseOptionalInt(
  value: string | undefined,
): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  return parseId(value);
}

const RESULT_STATUSES: readonly ResultStatus[] = [
  "running",
  "success",
  "error",
  "timeout",
];

export function parseStatus(
  value: string | undefined,
): ResultStatus | undefined | null {
  if (value === undefined || value === "") return undefined;
  return (RESULT_STATUSES as readonly string[]).includes(value)
    ? (value as ResultStatus)
    : null;
}

/** 条数类参数：没传用默认值，超过上限按上限算，不合法返回 null */
export function parseLimit(
  value: string | undefined,
  fallback: number,
  max: number,
): number | null {
  const parsed = parseOptionalInt(value);
  if (parsed === null) return null;
  if (parsed === undefined) return fallback;
  return Math.min(parsed, max);
}
