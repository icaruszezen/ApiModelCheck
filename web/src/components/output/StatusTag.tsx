// 占位：由输出展示模块实现
import { Tag } from "@endfield-ui/react";
import type { ResultStatus } from "../../../../shared/types.ts";

export interface StatusTagProps {
  status: ResultStatus;
  size?: "sm" | "md";
}

export function StatusTag({ status, size = "sm" }: StatusTagProps) {
  return <Tag size={size}>{status}</Tag>;
}
