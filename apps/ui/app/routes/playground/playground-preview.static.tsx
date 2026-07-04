import { Box } from 'lucide-react';
import type { PlaygroundExample } from '#routes/playground/playground-examples.js';
import type { PlaygroundMobilePane } from '#routes/playground/playground-preview.js';
import { cn } from '#utils/ui.utils.js';

export const playgroundPreviewCapabilities = {
  parameters: false,
} as const;

type PlaygroundPreviewPaneProps = {
  readonly activeExample: PlaygroundExample;
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly previewProjectId: string;
  readonly previewRenderKey: string;
  readonly staticPreviewUrl: string | undefined;
  readonly mobilePane: PlaygroundMobilePane;
  readonly exportControlsElement: HTMLDivElement | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
};

export function PlaygroundPreviewPane({ activeExample, mobilePane }: PlaygroundPreviewPaneProps): React.JSX.Element {
  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        activeExample.mode !== 'static' && mobilePane !== '3d' ? 'max-xl:hidden' : undefined,
      )}
    >
      <div className='relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30'>
        {activeExample.image ? (
          <img src={activeExample.image} alt='' loading='eager' decoding='async' className='size-full object-contain' />
        ) : (
          <div className='flex size-full items-center justify-center'>
            <Box className='size-12 text-muted-foreground/40' strokeWidth={1.25} aria-hidden />
          </div>
        )}
      </div>
    </section>
  );
}
