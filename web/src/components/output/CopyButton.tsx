import { Check, IconButton, Tooltip, useToast, type IconButtonProps } from "@endfield-ui/react";
import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "../icons";
import { copyText } from "./clipboard";

export interface CopyButtonProps {
  /** 要复制的文字 */
  text: string;
  /** 按钮的可访问名称和提示，如"复制原文" */
  label: string;
  size?: IconButtonProps["size"];
  variant?: IconButtonProps["variant"];
  className?: string;
}

/** 复制图标钮：复制成功后图标变成对勾一会儿，并弹一条轻提示 */
export function CopyButton({ text, label, size = "sm", variant = "plain", className }: CopyButtonProps) {
  const toast = useToast();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleClick = async () => {
    try {
      await copyText(text, buttonRef.current?.parentElement);
      setCopied(true);
      toast({ message: "已复制到剪贴板", tone: "success" });
    } catch {
      toast({ message: "复制失败，请手动选中文字复制", tone: "danger" });
    }
  };

  return (
    <Tooltip content={copied ? "已复制" : label}>
      <IconButton
        ref={buttonRef}
        size={size}
        variant={variant}
        aria-label={label}
        className={className}
        onClick={() => void handleClick()}
      >
        {copied ? <Check /> : <CopyIcon />}
      </IconButton>
    </Tooltip>
  );
}
