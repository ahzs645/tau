import { useState } from 'react';
import { Link } from 'react-router';
import { Tau } from '#components/icons/tau.js';
import { metaConfig } from '#constants/meta.constants.js';
import { CookiePreferencesDialog } from '#components/cookie-consent.js';

const navigationLinks = [
  { label: 'Home', href: '/' },
  { label: 'Docs', href: '/docs' },
  { label: 'Legal', href: '/legal' },
];

export function PageFooter(): React.JSX.Element {
  const [isCookieDialogOpen, setIsCookieDialogOpen] = useState(false);

  return (
    <footer className="shrink-0 border-t border-neutral/20 bg-background">
      <div className="container mx-auto flex h-10 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-foreground transition-colors hover:text-foreground/80">
            <Tau className="size-6 text-primary" />
          </Link>
          <nav className="flex items-center gap-4">
            {navigationLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setIsCookieDialogOpen(true);
              }}
            >
              Cookies
            </button>
            <a
              href={`mailto:${metaConfig.salesEmail}`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Contact
            </a>
          </nav>
        </div>
      </div>

      <CookiePreferencesDialog isOpen={isCookieDialogOpen} onOpenChange={setIsCookieDialogOpen} />
    </footer>
  );
}
