import { cn } from '#utils/ui.utils.js';

const topRest =
  'M256 66.6 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 116.55 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z';
const topFlex = 'M256 0 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 49.95 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z';
const leftRest =
  'M14.17 87.42 L62.54 99.9 L239.88 145.69 L239.88 462.05 L239.88 512 L191.51 499.51 L191.51 183.16 L14.17 137.37 Z';
const leftFlex =
  'M14.17 87.42 L62.54 99.9 L62.54 416.26 L239.88 462.05 L239.88 512 L191.51 499.51 L14.17 453.73 L14.17 137.37 Z';
const rightRest =
  'M497.83 87.41 L449.46 99.9 L272.12 145.69 L272.12 462.05 L272.12 512 L320.49 499.51 L320.49 183.16 L497.83 137.37 Z';
const rightFlex =
  'M497.83 87.41 L449.46 99.9 L449.46 416.26 L272.12 462.05 L272.12 512 L320.49 499.51 L497.83 453.73 L497.83 137.37 Z';

// CSS `cubic-bezier(0.85, 0, 0.15, 1)` rendered as SMIL spline control points
// (SMIL applies the same Bezier between every keyframe pair when `calcMode='spline'`).
const easeSpline = '0.85 0 0.15 1';
const easeSplinesFiveSegments = `${easeSpline};${easeSpline};${easeSpline};${easeSpline};${easeSpline}`;

const topKeyTimes = '0;0.12;0.27;0.53;0.68;1';
const leftKeyTimes = '0;0.05;0.20;0.46;0.61;1';
const rightKeyTimes = '0;0.19;0.34;0.60;0.75;1';

const topValues = `${topRest};${topRest};${topFlex};${topFlex};${topRest};${topRest}`;
const leftValues = `${leftRest};${leftRest};${leftFlex};${leftFlex};${leftRest};${leftRest}`;
const rightValues = `${rightRest};${rightRest};${rightFlex};${rightFlex};${rightRest};${rightRest}`;

export function LogoLoader({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <div className={cn('size-4', className)} style={{ zIndex: 10 }}>
      <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512' className='size-full'>
        <path fill='currentColor' d={topRest}>
          <animate
            attributeName='d'
            dur='1s'
            repeatCount='indefinite'
            calcMode='spline'
            keyTimes={topKeyTimes}
            keySplines={easeSplinesFiveSegments}
            values={topValues}
          />
        </path>
        <path fill='currentColor' d={leftRest}>
          <animate
            attributeName='d'
            dur='1s'
            repeatCount='indefinite'
            calcMode='spline'
            keyTimes={leftKeyTimes}
            keySplines={easeSplinesFiveSegments}
            values={leftValues}
          />
        </path>
        <path fill='currentColor' d={rightRest}>
          <animate
            attributeName='d'
            dur='1s'
            repeatCount='indefinite'
            calcMode='spline'
            keyTimes={rightKeyTimes}
            keySplines={easeSplinesFiveSegments}
            values={rightValues}
          />
        </path>
      </svg>
    </div>
  );
}
