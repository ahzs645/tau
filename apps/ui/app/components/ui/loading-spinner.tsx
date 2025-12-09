import { Loader2 } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';

export function LoadingSpinner({ className }: { readonly className?: string }): React.JSX.Element {
  return <Loader2 className={cn('size-4 animate-spin', className)} />;
}
