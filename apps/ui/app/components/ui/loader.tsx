import { Loader2 } from 'lucide-react';
import { LogoLoader } from '#components/logo-loader.js';

type LoaderProps = {
  readonly className?: string;
  readonly variant?: 'logo' | 'spinner';
};

export function Loader({ className, variant = 'logo' }: LoaderProps): React.JSX.Element {
  if (variant === 'spinner') {
    return <Loader2 className={`animate-spin ${className ?? ''}`} />;
  }

  return <LogoLoader className={className} />;
}
