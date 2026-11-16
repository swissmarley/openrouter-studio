import type { Metadata } from "next";
import { LogsPage } from "@/components/logs/logs-page";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Logs" };

export default function Page() {
  return (
    <RequireKey>
      <LogsPage />
    </RequireKey>
  );
}
