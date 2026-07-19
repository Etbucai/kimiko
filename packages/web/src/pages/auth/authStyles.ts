export const authFormClassName = "flex flex-col gap-4";

export const authLabelClassName =
  "flex flex-col gap-2 text-sm font-semibold text-[var(--text-h)]";

export const authInputClassName =
  "box-border w-full rounded-xl border border-[var(--border)] bg-[var(--input-bg)] px-3.5 py-3 text-[var(--text-h)] outline-none transition-[border-color,box-shadow] duration-200 focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-bg)]";

export const authButtonClassName =
  "min-h-[46px] rounded-xl border-0 bg-[var(--accent)] font-bold text-white transition-[filter,transform] duration-200 enabled:cursor-pointer enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70";

export const authErrorMessageClassName =
  "rounded-xl bg-[var(--danger-bg)] px-3 py-2.5 text-sm text-[var(--danger)]";

export const authSuccessMessageClassName =
  "mb-4 rounded-xl bg-[var(--success-bg)] px-3 py-2.5 text-sm text-[var(--success)]";
