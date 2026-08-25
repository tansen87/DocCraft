import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-border/50 bg-input shadow-[inset_0_1px_2px_rgb(0_0_0/0.08)] transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#54BD82] data-[state=checked]:bg-[#6FCF97] data-[state=checked]:dark:border-[#6E8B7A] data-[state=checked]:dark:bg-[#446351]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-background shadow-[0_1px_2px_rgb(0_0_0/0.2)] ring-1 ring-black/5 transition-transform data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-0 dark:ring-white/10",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
