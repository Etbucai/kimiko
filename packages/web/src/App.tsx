import type { JSX } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router";
import { Toaster } from "sonner";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/auth/LoginPage";
import { RegisterPage } from "./pages/auth/RegisterPage";
import { ModelDebugPage } from "./pages/debug/ModelDebugPage";
import { StoryContextDebugPage } from "./pages/story/StoryContextDebugPage";
import { StorylineListPage } from "./pages/story/StorylineListPage";
import { StoryPage } from "./pages/story/StoryPage";

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <StoryPage mode="recent" />
            </RequireAuth>
          }
        />
        <Route
          path="/storylines"
          element={
            <RequireAuth>
              <StorylineListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/storylines/new"
          element={
            <RequireAuth>
              <StoryPage mode="new" />
            </RequireAuth>
          }
        />
        <Route
          path="/storylines/:storylineId/context"
          element={
            <RequireAuth>
              <StorylineContextRoute />
            </RequireAuth>
          }
        />
        <Route
          path="/storylines/:storylineId"
          element={
            <RequireAuth>
              <StorylineDetailRoute />
            </RequireAuth>
          }
        />
        <Route
          path="/test/model"
          element={
            <RequireAuth>
              <ModelDebugPage />
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster duration={3000} position="top-center" />
    </BrowserRouter>
  );
}

function StorylineDetailRoute(): JSX.Element {
  const { storylineId } = useParams<"storylineId">();
  if (storylineId === undefined || storylineId.length === 0) {
    return <Navigate to="/storylines" replace />;
  }

  return (
    <StoryPage key={storylineId} mode="detail" storylineId={storylineId} />
  );
}

function StorylineContextRoute(): JSX.Element {
  const { storylineId } = useParams<"storylineId">();
  if (storylineId === undefined || storylineId.length === 0) {
    return <Navigate to="/storylines" replace />;
  }

  return <StoryContextDebugPage storylineId={storylineId} />;
}

export default App;
