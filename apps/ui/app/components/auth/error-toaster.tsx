import { useQueryClient } from '@tanstack/react-query';
import type { BetterFetchError } from 'better-auth/react';
import { useEffect } from 'react';
import { toast } from 'sonner';

export function ErrorToaster() {
  const queryClient = useQueryClient();

  useEffect(() => {
    queryClient.getQueryCache().config.onError = (error) => {
      const error_ = error as BetterFetchError;
      if (error_?.error) {
        toast.error(error_.error.message);
      }
    };

    queryClient.setMutationDefaults([], {
      onError: (error) => {
        toast.error((error as BetterFetchError)?.error?.message ?? error.message);
      },
    });
  }, [queryClient]);

  return null;
}
