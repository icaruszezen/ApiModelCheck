import { Button, EmptyState } from "@endfield-ui/react";
import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl items-center p-4">
      <EmptyState
        className="w-full"
        title="页面不存在"
        description="地址可能写错了，或者这个页面已经移走。"
        action={<Button render={<Link to="/" />}>回到检测页</Button>}
      />
    </main>
  );
}
