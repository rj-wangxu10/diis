"use client";

import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { configApi } from "../../lib/config-api/client";
import { useT } from "../../i18n/locale-context";

export type AuthMode = "login" | "register" | "forgot" | "verify" | "reset";

export const AUTH_BUTTON_CLASS =
  "flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-white transition-colors hover:bg-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Self-contained password auth journey. `login` and `register` are distinct
 * routes (`/login`, `/register`) so each has its own URL + tab title; the
 * transient steps (`forgot`/`reset`/`verify`) are sub-states of the route they
 * flow from and navigate back to the canonical routes when finished.
 */
export function AuthFlow({
  initialMode,
  onAuthenticated,
  error = null,
  registrationEnabled = true,
}: {
  initialMode: AuthMode;
  onAuthenticated: () => void | Promise<void>;
  error?: string | null;
  registrationEnabled?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const meta = useMemo(() => {
    switch (mode) {
      case "login":
        return { title: t("auth.signIn"), subtitle: t("auth.signInSubtitle"), submit: t("auth.signInSubmit") };
      case "register":
        return { title: t("auth.createAccount"), subtitle: t("auth.createAccountSubtitle"), submit: t("auth.createAccountSubmit") };
      case "forgot":
        return { title: t("auth.forgotPassword"), subtitle: t("auth.forgotPasswordSubtitle"), submit: t("auth.forgotPasswordSubmit") };
      case "verify":
        return { title: t("auth.verifyEmail"), subtitle: t("auth.verifyEmailSubtitle"), submit: t("auth.verifyEmailSubmit") };
      case "reset":
        return { title: t("auth.resetPassword"), subtitle: t("auth.resetPasswordSubtitle"), submit: t("auth.resetPasswordSubmit") };
    }
  }, [mode, t]);

  const goToSubMode = useCallback((next: AuthMode) => {
    setMode(next);
    setLocalError(null);
    setMessage(null);
  }, []);

  // Forgot/reset/verify are in-page sub-modes of /login or /register. Pushing
  // `/login` alone is a no-op when already on that route, so also reset mode.
  const goToLogin = useCallback(() => {
    goToSubMode("login");
    router.push("/login");
  }, [goToSubMode, router]);
  const goToRegister = useCallback(() => router.push("/register"), [router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setLocalError(null);
    setMessage(null);
    try {
      if ((mode === "register" || mode === "reset") && password.length < 6) {
        setLocalError(t("auth.passwordTooShort"));
        return;
      }
      if (mode === "login") {
        await configApi.login({ email, password });
        await onAuthenticated();
        return;
      }
      if (mode === "register") {
        const result = await configApi.register({ email, password, displayName });
        setMessage(
          result.verificationToken
            ? t("auth.verificationTokenMessage", { token: result.verificationToken })
            : t("auth.verifyEmailMessage"),
        );
        setMode("verify");
        return;
      }
      if (mode === "forgot") {
        const result = await configApi.forgotPassword({ email });
        setMessage(
          result.resetToken
            ? t("auth.resetTokenMessage", { token: result.resetToken })
            : t("auth.checkEmailMessage"),
        );
        setMode("reset");
        return;
      }
      if (mode === "verify") {
        await configApi.verifyEmail({ token });
        router.push("/login");
        return;
      }
      if (mode === "reset") {
        await configApi.resetPassword({ token, password });
        setMessage(t("auth.resetSuccessMessage"));
        setMode("login");
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("auth.authFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const shownError = localError || error;

  return (
    <PasswordAuthShell title={meta.title} subtitle={meta.subtitle}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {mode === "register" ? (
          <AuthField
            id="auth-display-name"
            label={t("auth.displayName")}
            value={displayName}
            onChange={setDisplayName}
            placeholder={t("auth.displayNamePlaceholder")}
            autoComplete="name"
          />
        ) : null}
        {mode === "verify" || mode === "reset" ? (
          <AuthField
            id="auth-token"
            label={mode === "verify" ? t("auth.verificationCode") : t("auth.resetCode")}
            value={token}
            onChange={setToken}
            placeholder={mode === "verify" ? t("auth.verificationCodePlaceholder") : t("auth.resetCodePlaceholder")}
            autoComplete="one-time-code"
          />
        ) : null}
        {mode !== "verify" && mode !== "reset" ? (
          <AuthField
            id="auth-email"
            label={t("auth.email")}
            type="email"
            value={email}
            onChange={setEmail}
            placeholder={t("auth.emailPlaceholder")}
            autoComplete="email"
          />
        ) : null}
        {mode !== "forgot" && mode !== "verify" ? (
          <AuthField
            id="auth-password"
            label={mode === "reset" ? t("auth.newPassword") : t("auth.password")}
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={mode === "login" ? t("auth.passwordPlaceholder") : t("auth.newPasswordPlaceholder")}
            hint={mode === "register" || mode === "reset" ? t("auth.passwordHint") : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            {...(mode === "login"
              ? {
                  action: (
                    <button
                      type="button"
                      onClick={() => goToSubMode("forgot")}
                      className="text-xs font-medium text-muted transition-colors hover:text-foreground"
                    >
                      {t("auth.forgotPasswordLink")}
                    </button>
                  ),
                }
              : {})}
          />
        ) : null}

        {message ? (
          <p role="status" className="rounded-md bg-surface-subtle px-3 py-2 text-xs leading-relaxed text-muted">
            {message}
          </p>
        ) : null}
        {shownError ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700"
          >
            <ErrorDotIcon />
            <span>{shownError}</span>
          </p>
        ) : null}

        <button className={AUTH_BUTTON_CLASS} disabled={submitting} type="submit">
          {submitting ? (
            <>
              <SpinnerIcon />
              <span>{t("auth.pleaseWait")}</span>
            </>
          ) : (
            meta.submit
          )}
        </button>
      </form>

      <AuthModeSwitch
        mode={mode}
        registrationEnabled={registrationEnabled}
        onGoLogin={goToLogin}
        onGoRegister={goToRegister}
      />
    </PasswordAuthShell>
  );
}

function AuthModeSwitch({
  mode,
  registrationEnabled,
  onGoLogin,
  onGoRegister,
}: {
  mode: AuthMode;
  registrationEnabled: boolean;
  onGoLogin: () => void;
  onGoRegister: () => void;
}) {
  const t = useT();
  const link = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="font-medium text-foreground underline-offset-2 transition-colors hover:text-primary-light hover:underline"
    >
      {label}
    </button>
  );

  return (
    <div className="mt-5 border-t border-border pt-4 text-center text-xs text-muted">
      {mode === "login" ? (
        registrationEnabled ? (
          <p>{t("auth.newToRuiJieDiiS")} {link(t("auth.createAccountLink"), onGoRegister)}</p>
        ) : (
          <p>{t("auth.registrationClosedContact")}</p>
        )
      ) : mode === "register" ? (
        <p>{t("auth.alreadyHaveAccount")} {link(t("auth.signInLink"), onGoLogin)}</p>
      ) : (
        <p>{link(t("auth.backToSignIn"), onGoLogin)}</p>
      )}
    </div>
  );
}

function AuthField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  autoComplete,
  action,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  autoComplete?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {action}
      </div>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-light hover:border-muted-light focus:border-primary focus:ring-2 focus:ring-primary/10"
      />
      {hint ? <p className="text-[11px] leading-relaxed text-muted-light">{hint}</p> : null}
    </div>
  );
}

export function PasswordAuthShell({
  children,
  title,
  subtitle,
}: {
  children?: ReactNode;
  title: string;
  subtitle?: string;
}) {
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-subtle p-6 text-foreground">
      <section className="auth-card-in w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-xs font-bold tracking-tight text-white">
              RJ
            </span>
            <span className="text-sm font-semibold text-foreground">{t("auth.brand")}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
          <div className="mb-5">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 animate-spin" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ErrorDotIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.9 10.5a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0ZM7.1 4.4a.9.9 0 0 1 1.8 0l-.2 3.8a.7.7 0 0 1-1.4 0l-.2-3.8Z" />
    </svg>
  );
}
