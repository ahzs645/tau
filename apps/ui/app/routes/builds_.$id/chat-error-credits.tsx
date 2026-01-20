import { memo } from 'react';
import type React from 'react';
import { CreditCard } from 'lucide-react';
import { NavLink } from 'react-router';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { Loader } from '#components/ui/loader.js';

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
        <Button asChild variant="default" size="sm">
          <NavLink to="/settings/billing" tabIndex={-1}>
            {({ isPending }) =>
              isPending ? (
                <Loader />
              ) : (
                <>
                  <CreditCard className="size-4" />
                  Add Credits
                </>
              )
            }
          </NavLink>
        </Button>
      </div>
    </div>
  );
});
