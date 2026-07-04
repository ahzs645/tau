import { AlertCircle } from 'lucide-react';

export function ErrorPage(): React.JSX.Element {
  return (
    <div className='flex min-h-full flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center'>
      <AlertCircle className='size-8 text-destructive' />
      <h1 className='text-lg font-semibold text-foreground'>Something went wrong</h1>
      <p className='max-w-sm text-sm text-muted-foreground'>Refresh the page and try again.</p>
    </div>
  );
}
