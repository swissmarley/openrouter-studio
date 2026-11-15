"use client";

import { PageHeader } from "../ui";
import { KeyCard } from "./key-card";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Your key, budgets, default models and agent import/export." />
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
        <KeyCard />
      </div>
    </>
  );
}
