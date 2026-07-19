import type { JSX } from "react";
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { LoginUserRequest } from "@kimiko/schema";
import { getErrorMessage, loginUser, saveAuthSession } from "../../auth/authApi";
import { AuthPage } from "./AuthPage";
import {
  authButtonClassName,
  authErrorMessageClassName,
  authFormClassName,
  authInputClassName,
  authLabelClassName,
  authSuccessMessageClassName,
} from "./authStyles";

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [uniqueName, setUniqueName] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const registered = useMemo(
    () => new URLSearchParams(location.search).get("registered") === "1",
    [location.search],
  );

  async function handleSubmit(): Promise<void> {
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const request = {
        uniqueName,
        password,
      } satisfies LoginUserRequest;
      const authSession = await loginUser(request);

      saveAuthSession(authSession);
      void navigate("/", { replace: true });
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthPage
      title="登录"
      description="使用用户名和密码进入 Kimiko。"
      footer={
        <>
          还没有账号？<Link to="/register">去注册</Link>
        </>
      }
    >
      {registered ? (
        <p className={authSuccessMessageClassName}>注册成功，请登录。</p>
      ) : null}
      <form
        className={authFormClassName}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <label className={authLabelClassName}>
          用户名
          <input
            autoComplete="username"
            className={authInputClassName}
            minLength={3}
            maxLength={32}
            name="uniqueName"
            onChange={(event) => setUniqueName(event.currentTarget.value)}
            required
            type="text"
            value={uniqueName}
          />
        </label>
        <label className={authLabelClassName}>
          密码
          <input
            autoComplete="current-password"
            className={authInputClassName}
            name="password"
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {errorMessage.length > 0 ? (
          <p className={authErrorMessageClassName} role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button
          className={authButtonClassName}
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? "登录中..." : "登录"}
        </button>
      </form>
    </AuthPage>
  );
}
