import { useSelector } from '@xstate/react';
import { Loader } from '#components/ui/loader.js';
import { useProject } from '#hooks/use-project.js';
import { useCadSelector } from '#hooks/use-cad.js';
import { cn } from '#utils/ui.utils.js';

export function ChatViewerStatus({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactNode {
  const { projectRef } = useProject();
  const cadState = useCadSelector((state) => state.value, undefined);
  const projectState = useSelector(projectRef, (state) => state.value);

  // Don't show loading states if the project failed to load (e.g., not found)
  if (projectState === 'error') {
    return null;
  }

  const loadingState =
    typeof cadState === 'string' && ['rendering', 'connecting', 'buffering'].includes(cadState) ? cadState : undefined;
  return loadingState ? (
    <div
      {...props}
      className={cn(
        'm-auto flex items-center gap-2 rounded-md border bg-background/70 p-1 backdrop-blur-sm md:px-2',
        className,
      )}
    >
      <Loader className='size-4 text-primary md:size-6' />
      <span className='font-mono text-sm text-muted-foreground capitalize'>{loadingState}...</span>
    </div>
  ) : null;
}
