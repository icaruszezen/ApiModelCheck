/**
 * 后台各页共用的小件：出错信息、确认弹窗、页面外框、表格的操作列。
 */
import { Button, Dialog, PageHeader } from "@endfield-ui/react";
import { useState, type ReactNode } from "react";

export { errorMessage } from "./error-text";

export {
  STICKY_END_CELL,
  STICKY_END_HEAD,
  stickyEndHeadRef,
} from "./sticky-end";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** 确认按钮上的字，如"删除" */
  confirmLabel: string;
  /** 破坏性操作用 danger（默认） */
  tone?: "danger" | "default";
  /** 点确认后执行；返回的 Promise 结束前按钮显示加载中，出错时弹窗不关、错误由调用方提示 */
  onConfirm: () => Promise<void> | void;
}

/** 破坏性操作的确认：点遮罩不关，确认执行完才关 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "danger",
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      alert
      size="sm"
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="light" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "action"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch {
                // 错误由 onConfirm 自己提示，弹窗留着
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export interface AdminPageProps {
  title: string;
  /** 标题上面的微文字，如 "// CHANNELS" */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** 后台每一页的外框：页头 + 内容 */
export function AdminPage({ title, meta, description, actions, children }: AdminPageProps) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} meta={meta} description={description} actions={actions} />
      {children}
    </div>
  );
}
