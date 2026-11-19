import { useCallback, useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@taucad/ui/components/dialog';
import { Input } from '@taucad/ui/components/input';
import { errorMessage } from '#components/download.js';

export const ShareDialog = ({
  url,
  title,
  hasUploads,
}: {
  readonly url: string;
  readonly title: string;
  readonly hasUploads: boolean;
}): React.JSX.Element => {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setError(undefined);
    } catch {
      setError('Copy was unavailable. Select the link below and copy it.');
    }
  }, [url]);
  const share = useCallback(async () => {
    try {
      await navigator.share({ url, title });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setError(errorMessage(error));
      }
    }
  }, [url, title]);
  return (
    <Dialog
      onOpenChange={() => {
        setCopied(false);
        setError(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button variant='outline' size='touch'>
          <Share2 aria-hidden />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Share {title}</DialogTitle>
        <DialogDescription>This link opens the selected variant with your current parameters.</DialogDescription>
        <Input
          aria-label='Share link'
          value={url}
          readOnly
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className='h-11 text-base'
        />
        {hasUploads ? (
          <p className='text-sm'>Uploaded files stay in this browser and are not included in this link.</p>
        ) : null}
        <div className='flex flex-wrap gap-2'>
          <Button onClick={copy} size='touch'>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {typeof navigator.share === 'function' ? (
            <Button variant='outline' size='touch' onClick={share}>
              Share to…
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role='alert' className='text-sm'>
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
