import { cn } from '#utils/ui.utils.js';

const styles = `
  @keyframes tau-flex-left {
    0%, 5% { d: path("M14.17 87.42 L62.54 99.9 L239.88 145.69 L239.88 462.05 L239.88 512 L191.51 499.51 L191.51 183.16 L14.17 137.37 Z"); }
    20%, 46% { d: path("M14.17 87.42 L62.54 99.9 L62.54 416.26 L239.88 462.05 L239.88 512 L191.51 499.51 L14.17 453.73 L14.17 137.37 Z"); }
    61%, 100% { d: path("M14.17 87.42 L62.54 99.9 L239.88 145.69 L239.88 462.05 L239.88 512 L191.51 499.51 L191.51 183.16 L14.17 137.37 Z"); }
  }
  @keyframes tau-flex-top {
    0%, 12% { d: path("M256 66.6 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 116.55 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z"); }
    27%, 53% { d: path("M256 0 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 49.95 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z"); }
    68%, 100% { d: path("M256 66.6 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 116.55 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z"); }
  }
  @keyframes tau-flex-right {
    0%, 19% { d: path("M497.83 87.41 L449.46 99.9 L272.12 145.69 L272.12 462.05 L272.12 512 L320.49 499.51 L320.49 183.16 L497.83 137.37 Z"); }
    34%, 60% { d: path("M497.83 87.41 L449.46 99.9 L449.46 416.26 L272.12 462.05 L272.12 512 L320.49 499.51 L497.83 453.73 L497.83 137.37 Z"); }
    75%, 100% { d: path("M497.83 87.41 L449.46 99.9 L272.12 145.69 L272.12 462.05 L272.12 512 L320.49 499.51 L320.49 183.16 L497.83 137.37 Z"); }
  }
`;

export function LogoLoader({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <div className={cn('size-4', className)} style={{ zIndex: 10 }}>
      <style>{styles}</style>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="size-full">
        <path
          fill="currentColor"
          d="M256 66.6 L384.97 33.3 L481.7 58.28 L384.97 83.25 L256 116.55 L127.03 83.25 L30.3 58.28 L127.03 33.3 Z"
          style={{ animation: 'tau-flex-top 1s cubic-bezier(0.85, 0, 0.15, 1) infinite' }}
        />
        <path
          fill="currentColor"
          d="M14.17 87.42 L62.54 99.9 L239.88 145.69 L239.88 462.05 L239.88 512 L191.51 499.51 L191.51 183.16 L14.17 137.37 Z"
          style={{ animation: 'tau-flex-left 1s cubic-bezier(0.85, 0, 0.15, 1) infinite' }}
        />
        <path
          fill="currentColor"
          d="M497.83 87.41 L449.46 99.9 L272.12 145.69 L272.12 462.05 L272.12 512 L320.49 499.51 L320.49 183.16 L497.83 137.37 Z"
          style={{ animation: 'tau-flex-right 1s cubic-bezier(0.85, 0, 0.15, 1) infinite' }}
        />
      </svg>
    </div>
  );
}
