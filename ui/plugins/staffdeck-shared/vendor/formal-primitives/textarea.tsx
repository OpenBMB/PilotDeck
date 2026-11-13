import * as React from "react"

import { useI18n } from "./locale"
import { cn } from "../../../../src/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(function Textarea({ className, ...props }, ref) {
  const { t } = useI18n()
  const localizedProps = {
    ...props,
    placeholder: typeof props.placeholder === "string" ? t(props.placeholder) : props.placeholder,
    title: typeof props.title === "string" ? t(props.title) : props.title,
    "aria-label": typeof props["aria-label"] === "string" ? t(props["aria-label"]) : props["aria-label"],
  }

  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-fixed min-h-16 w-full overflow-y-auto rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className
      )}
      {...localizedProps}
    />
  )
})

export { Textarea }
