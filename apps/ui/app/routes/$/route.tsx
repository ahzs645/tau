import { PageNotFound } from '#components/page-not-found.js';
import type { Handle } from '#types/matches.types.js';

export const handle: Handle = {
  enablePageFooter: true,
};

export default function NotFoundPage(): React.JSX.Element {
  return <PageNotFound />;
}
