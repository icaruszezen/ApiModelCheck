/**
 * 提示词表单的数据与校验，以及列表、下拉里用到的几个显示函数。
 */
import type {
  AdminModel,
  AdminPrompt,
  PromptInput,
} from "../../../../shared/types.ts";
import {
  compactErrors,
  hasErrors,
  parseSortOrder,
  SORT_ORDER_ERROR,
  textError,
  type FieldErrors,
  type FormResult,
} from "./shell-form";

export const PROMPT_TITLE_MAX = 100;
export const PROMPT_CONTENT_MAX = 20000;

export interface PromptFormValues {
  title: string;
  /** 原样发给模型，不去首尾空白 */
  content: string;
  /** 组合框的值是字符串形式的模型 id */
  modelIds: string[];
  sortOrder: string;
  enabled: boolean;
}

export type PromptField = "title" | "content" | "modelIds" | "sortOrder";

export type PromptFormErrors = FieldErrors<PromptField>;

export function emptyPromptForm(): PromptFormValues {
  return {
    title: "",
    content: "",
    modelIds: [],
    sortOrder: "0",
    enabled: true,
  };
}

export function promptToForm(prompt: AdminPrompt): PromptFormValues {
  return {
    title: prompt.title,
    content: prompt.content,
    modelIds: prompt.modelIds.map(String),
    sortOrder: String(prompt.sortOrder),
    enabled: prompt.enabled,
  };
}

export interface PromptValidateOptions {
  /**
   * 现有模型的 id。为 null 表示模型列表没能加载：这时不提交 modelIds，
   * 服务器保持原来的分配关系，免得把它清空。
   */
  knownModelIds: ReadonlySet<number> | null;
}

export function validatePromptForm(
  values: PromptFormValues,
  { knownModelIds }: PromptValidateOptions,
): FormResult<PromptField, PromptInput> {
  const errors: PromptFormErrors = {};
  errors.title = textError("标题", values.title, PROMPT_TITLE_MAX, true);
  if (values.content.trim() === "") {
    errors.content = "内容不能为空";
  } else if (values.content.length > PROMPT_CONTENT_MAX) {
    errors.content = `内容不能超过 ${PROMPT_CONTENT_MAX} 个字符`;
  }
  const sortOrder = parseSortOrder(values.sortOrder);
  if (sortOrder === null) errors.sortOrder = SORT_ORDER_ERROR;

  if (hasErrors(errors) || sortOrder === null) {
    return { errors: compactErrors(errors), input: null };
  }

  const input: PromptInput = {
    title: values.title.trim(),
    content: values.content,
    enabled: values.enabled,
    sortOrder,
  };
  if (knownModelIds) {
    // 打开表单之后被别处删掉的模型直接丢掉，否则服务器会因为"模型不存在"拒绝整个保存
    const ids = values.modelIds
      .map(Number)
      .filter((id) => Number.isInteger(id) && knownModelIds.has(id));
    input.modelIds = [...new Set(ids)];
  }
  return { errors: {}, input };
}

/** 列表里直接拨"启用"开关时提交的请求体：不带 modelIds，分配关系不动 */
export function promptToggleInput(
  prompt: AdminPrompt,
  enabled: boolean,
): PromptInput {
  return {
    title: prompt.title,
    content: prompt.content,
    enabled,
    sortOrder: prompt.sortOrder,
  };
}

/** 列表里的一行预览：空白折成一个空格；只截掉明显看不到的部分，省略号由样式负责 */
export function contentPreview(content: string, max = 240): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 下拉里一个模型的名字："渠道名 / 显示名或模型 ID" */
export function modelOptionLabel(
  model: Pick<AdminModel, "channelName" | "displayName" | "model" | "enabled">,
): string {
  const name = model.displayName.trim() || model.model;
  return `${model.channelName} / ${name}${model.enabled ? "" : "（已停用）"}`;
}
