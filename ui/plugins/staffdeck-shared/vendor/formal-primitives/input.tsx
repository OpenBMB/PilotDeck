import * as React from "react"

import { useI18n } from "./locale"
import { cn } from "../../../../src/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input({ className, type, ...props }, ref) {
  const { t } = useI18n()
  const localizedProps = {
    ...props,
    placeholder: typeof props.placeholder === "string" ? t(props.placeholder) : props.placeholder,
    title: typeof props.title === "string" ? t(props.title) : props.title,
    "aria-label": typeof props["aria-label"] === "string" ? t(props["aria-label"]) : props["aria-label"],
  }

  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className
      )}
      {...localizedProps}
    />
  )
})

export { Input }
