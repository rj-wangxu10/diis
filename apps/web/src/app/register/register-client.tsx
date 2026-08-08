"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthFlow, PasswordAuthShell } from "../../components/auth/auth-flow";
import { configApi } from "../../lib/config-api/client";
import { useT } from "../../i18n/locale-context";

export function RegisterClient() {
  const router = useRouter();
  const t = useT();
  const [checking, setChecking] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      configApi.getMe().then(() => true).catch(() => false),
      configApi.getAuthStatus().then((status) => status.registrationEnabled).catch(() => true),
    ]).then(([signedIn, canRegister]) => {
      if (cancelled) return;
      if (signedIn) {
        router.replace("/data-tasks");
        return;
      }
      setRegistrationEnabled(canRegister);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return <PasswordAuthShell title={t("auth.signInLoading")} />;
  }

  if (!registrationEnabled) {
    return (
      <PasswordAuthShell
        title={t("auth.registrationClosed")}
        subtitle={t("auth.registrationClosedSubtitle")}
      >
        <button
          type="button"
          className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => router.push("/login")}
        >
          {t("auth.backToSignInLink")}
        </button>
      </PasswordAuthShell>
    );
  }

  return (
    <AuthFlow
      initialMode="register"
      registrationEnabled={registrationEnabled}
      onAuthenticated={() => router.replace("/data-tasks")}
    />
  );
}
