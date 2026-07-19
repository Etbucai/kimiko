import type { JSX } from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { LoginUserRequest, RegisterUserRequest } from "@kimiko/schema";
import {
  getErrorMessage,
  loginUser,
  registerUser,
  saveAuthSession,
} from "../../auth/authApi";
import { AuthPage } from "./AuthPage";
import {
  authButtonClassName,
  authErrorMessageClassName,
  authFormClassName,
  authInputClassName,
  authLabelClassName,
} from "./authStyles";

export function RegisterPage(): JSX.Element {
  const navigate = useNavigate();
  const [uniqueName, setUniqueName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(): Promise<void> {
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const request = {
        uniqueName,
        displayName,
        password,
      } satisfies RegisterUserRequest;

      await registerUser(request);
      const loginRequest = {
        uniqueName,
        password,
      } satisfies LoginUserRequest;
      const authSession = await loginUser(loginRequest);

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
      title="注册"
      description="创建一个用于登录 Kimiko 的账号。"
      footer={
        <>
          已有账号？<Link to="/login">去登录</Link>
        </>
      }
    >
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
          昵称
          <input
            autoComplete="name"
            className={authInputClassName}
            maxLength={64}
            name="displayName"
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            required
            type="text"
            value={displayName}
          />
        </label>
        <label className={authLabelClassName}>
          密码
          <input
            autoComplete="new-password"
            className={authInputClassName}
            maxLength={72}
            minLength={8}
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
          {isSubmitting ? "注册中..." : "注册"}
        </button>
      </form>
    </AuthPage>
  );
}
