import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";

import "highlight.js/styles/github-dark.css";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface PreviewPaneProps {
  markdown: string;
  processingTimeMs: number;
  onExport: () => void;
  className?: string;
}

export function PreviewPane({
  markdown,
  processingTimeMs,
  onExport,
  className,
}: PreviewPaneProps) {
  const [mode, setMode] = useState<"raw" | "render">("render");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Markdown</p>
          <p className="text-xs text-muted-foreground">
            转换耗时 {processingTimeMs} ms · {markdown.length} 字符
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setMode("render")}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              mode === "render"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            渲染
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              mode === "raw"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            原始
          </button>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={copy}>
          {copied ? <Check className="text-emerald-500" /> : <Copy />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onExport}>
          <Download />
        </Button>
      </div>

      {mode === "raw" ? (
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">
            {markdown}
          </pre>
        </ScrollArea>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <article className="markdown-body p-4">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {markdown}
            </ReactMarkdown>
          </article>
        </ScrollArea>
      )}
    </div>
  );
}