import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/auth/LoginPage";
import { RegisterPage } from "./pages/auth/RegisterPage";

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <HomePage />
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
