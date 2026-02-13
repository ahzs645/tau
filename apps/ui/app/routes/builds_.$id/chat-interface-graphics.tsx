import type { StateFrom } from 'xstate';
import { X } from 'lucide-react';
import { ChatInterfaceGraphicsMeasure } from '#routes/builds_.$id/chat-interface-graphics-measure.js';
import { ChatInterfaceGraphicsSectionView } from '#routes/builds_.$id/chat-interface-graphics-section-view.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';

type ChatInterfaceGraphicsProps = {
  readonly className?: string;
};

const titleFromState = (state: StateFrom<typeof graphicsMachine>): string => {
  switch (true) {
    case state.matches({ operational: 'section-view' }): {
      return 'Section View';
    }
  }

  if (state.matches({ operational: 'measure' })) {
    return 'Measure';
  }

  return 'Unknown';
};

export function ChatInterfaceGraphics({ className }: ChatInterfaceGraphicsProps): React.ReactNode {
  const graphicsRef = useGraphics();
  const graphicsState = useGraphicsSelector((state) => state);
  if (graphicsState.matches({ operational: 'ready' })) {
    return null;
  }

  const title = titleFromState(graphicsState);

  return (
    <div
      className={cn('pointer-events-auto flex h-1/2 w-80 flex-col gap-2 rounded-md border bg-sidebar p-2', className)}
    >
      <div className="flex items-center justify-between px-1">
        <div className="text-sm font-medium">{title}</div>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 size-7"
          onClick={() => {
            // Reset to default: disable section view and measure, clear unpinned hovers
            if (graphicsState.context.isMeasureActive) {
              graphicsRef.send({ type: 'setMeasureActive', payload: false });
            }

            if (graphicsState.context.isSectionViewActive) {
              graphicsRef.send({ type: 'setSectionViewActive', payload: false });
            }

            graphicsRef.send({ type: 'setHoveredMeasurement', payload: undefined });
          }}
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      <ChatInterfaceGraphicsInner />
    </div>
  );
}

function ChatInterfaceGraphicsInner(): React.JSX.Element {
  const graphicsState = useGraphicsSelector((state) => state);

  switch (true) {
    case graphicsState.matches({ operational: 'section-view' }): {
      return <ChatInterfaceGraphicsSectionView />;
    }

    case graphicsState.matches({ operational: 'measure' }): {
      return <ChatInterfaceGraphicsMeasure />;
    }

    default: {
      return <div>Unknown graphics state</div>;
    }
  }
}
