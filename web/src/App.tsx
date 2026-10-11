import { Loader, ToastProvider } from "@endfield-ui/react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { NotFoundPage } from "./pages/NotFoundPage";
import { BoardPage } from "./pages/board/BoardPage";

// 后台单独打一个包：访客打开前台时不会下载后台的代码
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
              <Suspense fallback={<Loader tagline="正在载入后台" />}>
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
