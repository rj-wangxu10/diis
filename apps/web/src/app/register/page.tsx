import type { Metadata } from "next";
import { RegisterClient } from "./register-client";
import { LocaleProvider } from "../../i18n/locale-context";

export const metadata: Metadata = {
  title: "创建账户",
};

export default function RegisterPage() {
  return (
    <LocaleProvider>
      <RegisterClient />
    </LocaleProvider>
  );
}
