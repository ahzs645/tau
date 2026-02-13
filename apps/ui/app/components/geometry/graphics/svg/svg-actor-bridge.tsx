import { useEffect } from 'react';
import type { RefObject, ReactNode } from 'react';
import { useScreenshotCapability } from '#hooks/use-graphics.js';

/**
 * Bridges the SVG rendering context with the screenshot capability machine.
 * Registers the SVG element for flat-image screenshot capture on mount
 * and unregisters on unmount – mirroring the Three.js ActorBridge pattern.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref API requires null
export function SvgActorBridge({ svgRef }: { readonly svgRef: RefObject<SVGSVGElement | null> }): ReactNode {
  const screenshotCapabilityActor = useScreenshotCapability();

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) {
      return;
    }

    screenshotCapabilityActor.send({
      type: 'registerSvgCapture',
      svgElement,
    });

    return () => {
      screenshotCapabilityActor.send({ type: 'unregisterCapture', captureMode: 'svg' });
    };
  }, [svgRef, screenshotCapabilityActor]);

  return null;
}
