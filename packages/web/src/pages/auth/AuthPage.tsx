import type { JSX, ReactNode } from "react";
import { Link } from "react-router";

interface AuthPageProps {
  children: ReactNode;
  description: string;
  footer: ReactNode;
  title: string;
}

export function AuthPage({
  children,
  description,
  footer,
  title,
}: AuthPageProps): JSX.Element {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)]">
      <section className="box-border w-[min(100%,420px)] rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-7 text-left shadow-[var(--shadow)] md:p-9">
        <div className="mb-6">
          <Link
            className="mb-5 inline-flex font-bold text-[var(--accent)] no-underline"
            to="/"
          >
            Kimiko
          </Link>
          <h1 className="my-5 text-4xl font-medium tracking-[-1.08px] text-[var(--text-h)] md:my-8 md:text-[56px] md:tracking-[-1.68px]">
            {title}
          </h1>
          <p className="m-0 text-[var(--text)]">{description}</p>
        </div>
        {children}
        <p className="mt-[22px] text-center text-sm text-[var(--text)] [&_a]:font-bold [&_a]:text-[var(--accent)] [&_a]:no-underline">
          {footer}
        </p>
      </section>
    </main>
  );
}
