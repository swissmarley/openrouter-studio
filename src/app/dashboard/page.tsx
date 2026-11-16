import type { Metadata } from "next";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page() {
  return (
    <RequireKey>
      <DashboardPage />
    </RequireKey>
  );
}
