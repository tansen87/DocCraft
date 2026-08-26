import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize, Minimize, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";

function IconButton({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    void win
      .onResized(() => {
        void win
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  function minimize() {
    void getCurrentWindow()
      .minimize()
      .catch(() => {});
  }

  function toggleMaximize() {
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => {});
  }

  function close() {
    void getCurrentWindow()
      .close()
      .catch(() => {});
  }

  return (
    <div className="flex shrink-0 items-center">
      <IconButton onClick={minimize}>
        <Minus className="size-4" />
      </IconButton>
      <IconButton onClick={toggleMaximize}>
        {maximized ? (
          <Minimize className="size-3.5" />
        ) : (
          <Maximize className="size-3.5" />
        )}
      </IconButton>
      <IconButton
        onClick={close}
        className="hover:bg-destructive/15 hover:text-destructive"
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}
