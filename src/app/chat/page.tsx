import type { Metadata } from "next";
import { Suspense } from "react";
import { Playground } from "@/components/chat/playground";
import { RequireKey } from "@/components/session";

export const metadata: Metadata = { title: "Chat" };

export default function ChatPage() {
  return (
    <RequireKey>
      {/* useSearchParams (for ?model=) needs a Suspense boundary to keep the shell static. */}
      <Suspense>
        <Playground />
      </Suspense>
    </RequireKey>
  );
}
