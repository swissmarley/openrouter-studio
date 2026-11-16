import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentsPage } from "@/components/agents/agents-page";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return (
    <RequireKey>
      <Suspense>
        <AgentsPage />
      </Suspense>
    </RequireKey>
  );
}
