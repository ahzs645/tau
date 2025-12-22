import { Link } from 'react-router';
import cookiePolicy from '#routes/legal.cookies/cookie-policy.txt?raw';
import { Button } from '#components/ui/button.js';
import type { Handle } from '#types/matches.types.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/legal/cookies">Cookie Policy</Link>
      </Button>
    );
  },
};

export default function Cookies(): React.JSX.Element {
  return <MarkdownViewer isStreaming={false}>{cookiePolicy}</MarkdownViewer>;
}
