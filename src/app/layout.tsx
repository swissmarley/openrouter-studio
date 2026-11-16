import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OpenRouter Studio", template: "%s · OpenRouter Studio" },
  description: "Explore models, chat, build agents and run evals on OpenRouter from one place.",
};

// Runs before first paint so the stored (or system) theme is applied without a flash.
const themeScript = `(function(){try{var t=localStorage.getItem("ors-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
