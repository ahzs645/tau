import { Link } from 'react-router';
import termsOfService from '#routes/legal.terms/terms-of-service.txt?raw';
import { Button } from '#components/ui/button.js';
import type { Handle } from '#types/matches.types.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/legal/terms">Terms of Service</Link>
      </Button>
    );
  },
};

export default function Terms(): React.JSX.Element {
  return <MarkdownViewer isStreaming={false}>{termsOfService}</MarkdownViewer>;
}
