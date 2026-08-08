import type { Metadata } from "next";
import { LoginClient } from "./login-client";
import { LocaleProvider } from "../../i18n/locale-context";

export const metadata: Metadata = {
  title: "登录",
};

export default function LoginPage() {
  return (
    <LocaleProvider>
      <LoginClient />
    </LocaleProvider>
  );
}
