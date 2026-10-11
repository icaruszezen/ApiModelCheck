import { ToastProvider } from "@endfield-ui/react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { AdminLoading } from "./components/AdminLoading";
import { NotFoundPage } from "./pages/NotFoundPage";
import { BoardPage } from "./pages/board/BoardPage";

// 后台单独打一个包：访客打开前台时不会下载后台的代码。
// 载入时的提示和 AdminApp 确认登录状态时是同一个组件，两段接成一段
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={<AdminLoading />}>
                <AdminApp />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
