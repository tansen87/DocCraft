import * as React from "react";

import { cn } from "@/lib/utils";

function GlassPanel({
  className,
  hover,
  blur = true,
  ...props
}: React.ComponentProps<"div"> & {
  hover?: boolean;
  blur?: boolean;
}) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(
        "glass-panel",
        blur && "glass-blur",
        hover && "glass-hover",
        className,
      )}
      {...props}
    />
  );
}

export { GlassPanel };
