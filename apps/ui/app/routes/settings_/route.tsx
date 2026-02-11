import { redirect } from 'react-router';

/**
 * Redirect /settings to /?settings=general
 *
 * The settings dialog is now a global modal driven by the `?settings`
 * search param. This route ensures direct navigation or bookmarked
 * links to `/settings` produce a proper 302 redirect.
 */
export function loader(): Response {
  return redirect('/?settings=general');
}
