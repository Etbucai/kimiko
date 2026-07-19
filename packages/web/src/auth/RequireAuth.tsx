import type { JSX, ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { getStoredAuthSession } from "./authApi";

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps): JSX.Element {
  const location = useLocation();
  const authSession = getStoredAuthSession();

  if (authSession === null) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
