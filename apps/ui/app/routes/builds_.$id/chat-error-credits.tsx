import { memo } from 'react';
import type React from 'react';
import { CreditCard } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { openSettingsDialog } from '#hooks/use-settings-dialog.js';

export const ChatErrorCredits = memo(function ({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3 rounded-md border border-warning/20 bg-warning/10 p-3 text-sm', className)}>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground">Credit Limit Reached</p>
        <p className="text-xs text-muted-foreground">
          You have run out of credits. Please add more credits to continue using Tau.
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            openSettingsDialog('billing');
          }}
        >
          <CreditCard className="size-4" />
          Add Credits
        </Button>
      </div>
    </div>
  );
});
