import type { Metadata } from "next";
import { Suspense } from "react";
import { EvalsPage } from "@/components/evals/evals-page";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Evals" };

export default function Page() {
  return (
    <RequireKey>
      <Suspense>
        <EvalsPage />
      </Suspense>
    </RequireKey>
  );
}
