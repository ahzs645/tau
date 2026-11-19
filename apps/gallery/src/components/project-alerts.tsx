import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';

export const ProjectAlerts = ({
  parameterError,
  hasUnknownVariant,
  modelError,
  operationError,
  hasPreview,
  onReset,
  onRetry,
}: {
  readonly parameterError?: string;
  readonly hasUnknownVariant: boolean;
  readonly modelError?: string;
  readonly operationError?: string;
  readonly hasPreview: boolean;
  readonly onReset: () => void;
  readonly onRetry: () => void;
}): React.JSX.Element => (
  <>
    {(parameterError ?? hasUnknownVariant) ? (
      <div role='alert' className='flex flex-wrap items-start gap-2 border-b px-4 py-3 text-sm'>
        <span className='flex h-lh shrink-0 items-center'>
          <AlertCircle aria-hidden className='size-4 text-feature' />
        </span>
        <span className='min-w-0 flex-1'>
          {parameterError ?? 'This variant is unavailable. The default variant is selected.'}
        </span>
        <Button variant='outline' size='sm' onClick={onReset}>
          Use default parameters
        </Button>
      </div>
    ) : null}
    {(modelError ?? operationError) ? (
      <div role='alert' className='flex flex-wrap items-start gap-3 border-b px-4 py-3 text-sm'>
        <span className='flex h-lh shrink-0 items-center'>
          <AlertCircle aria-hidden className='size-4 text-feature' />
        </span>
        <div className='min-w-0 flex-1'>
          <p>
            {operationError
              ? 'The operation could not finish.'
              : hasPreview
                ? 'The model could not update. The last successful preview is still visible.'
                : 'The model could not load.'}
          </p>
          <details className='mt-1 text-xs text-muted-foreground'>
            <summary>Error details</summary>
            <pre className='mt-2 max-h-36 overflow-auto break-words whitespace-pre-wrap'>
              {operationError ?? modelError}
            </pre>
          </details>
        </div>
        <Button variant='outline' size='touch' onClick={onRetry}>
          <RotateCcw aria-hidden />
          Retry model
        </Button>
      </div>
    ) : null}
  </>
);
