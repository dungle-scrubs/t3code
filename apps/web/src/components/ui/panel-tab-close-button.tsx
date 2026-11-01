import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { keyboardHintProps } from "~/lib/keyboardHints";

interface PanelTabCloseButtonProps {
  children: ReactNode;
  closeIconId?: string | undefined;
  keyboardHint?: Parameters<typeof keyboardHintProps>[0] | undefined;
  label: string;
  onClick: () => void;
  revealCloseOnHints?: boolean;
  tooltip?: string;
}

export function PanelTabCloseButton({
  children,
  closeIconId,
  keyboardHint,
  label,
  onClick,
  revealCloseOnHints = false,
  tooltip,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
      aria-label={label}
      onClick={onClick}
      {...keyboardHintProps(keyboardHint ?? {})}
    >
      <span
        className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden"
        {...(revealCloseOnHints ? { "data-keyboard-hint-close-placeholder": "" } : {})}
      >
        {children}
      </span>
      <X
        id={closeIconId}
        className="hidden size-3 group-hover/tab:block group-focus-visible/close:block"
        {...(revealCloseOnHints ? { "data-keyboard-hint-close-icon": "" } : {})}
      />
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
