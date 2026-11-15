import type { Metadata } from "next";
import { ModelExplorer } from "@/components/models/explorer";

export const metadata: Metadata = { title: "Models" };

export default function ModelsPage() {
  return <ModelExplorer />;
}
