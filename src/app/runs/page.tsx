import type { Metadata } from "next";
import { Suspense } from "react";
import { RunsPage } from "@/components/runs/runs-page";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Runs" };

export default function Page() {
  return (
    <RequireKey>
      <Suspense>
        <RunsPage />
      </Suspense>
    </RequireKey>
  );
}
