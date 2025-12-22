import { Link } from 'react-router';
import privacyPolicy from '#routes/legal.privacy/privacy-policy.txt?raw';
import { Button } from '#components/ui/button.js';
import type { Handle } from '#types/matches.types.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/legal/privacy">Privacy Policy</Link>
      </Button>
    );
  },
};

export default function Privacy(): React.JSX.Element {
  return <MarkdownViewer isStreaming={false}>{privacyPolicy}</MarkdownViewer>;
}
