import { memo } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { LoadingSpinner } from '#components/ui/loading-spinner.js';

type ChatTextareaSubmitButtonProperties = {
  readonly status: string;
  readonly isSubmitting: boolean;
  readonly isDisabled: boolean;
  readonly formattedCancelKeyCombination: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
};

/**
 * Shared submit/cancel button component for the chat textarea.
 * Shows a stop button when streaming, otherwise shows a submit button.
 */
export const ChatTextareaSubmitButton = memo(function ({
  status,
  isSubmitting,
  isDisabled,
  formattedCancelKeyCombination,
  onSubmit,
  onCancel,
}: ChatTextareaSubmitButtonProperties): React.JSX.Element {
  if (status === 'streaming') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" className="size-7 rounded-full" onClick={onCancel}>
            <Square className="size-4 fill-primary-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2 align-baseline">
          Stop <KeyShortcut variant="tooltip">{formattedCancelKeyCombination}</KeyShortcut>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" className="size-7 rounded-full" disabled={isDisabled || isSubmitting} onClick={onSubmit}>
          {isSubmitting ? <LoadingSpinner className="size-4" /> : <ArrowUp className="size-5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2 align-baseline">
        Send <KeyShortcut variant="tooltip">{formatKeyCombination({ key: 'Enter' })}</KeyShortcut>
      </TooltipContent>
    </Tooltip>
  );
});
