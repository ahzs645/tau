import { redirect } from 'react-router';

/**
 * Redirects requests from a subdomain to the apex domain if the subdomain matches.
 * Throws a redirect Response if the subdomain matches, otherwise does nothing.
 *
 * @param request - The incoming request object
 * @param subdomain - The subdomain to redirect from (e.g., 'www')
 * @param statusCode - HTTP status code for the redirect (default: 301 permanent)
 * @throws {Response} Redirect response if subdomain matches
 *
 * @example
 * // In a loader, redirect www.example.com to example.com
 * throwRedirectIfSubdomain(request, 'www');
 */
export function throwRedirectIfSubdomain(request: Request, subdomain: string, statusCode = 301): void {
  const url = new URL(request.url);
  const hostnameParts = url.hostname.split('.');

  if (hostnameParts[0] === subdomain) {
    url.hostname = hostnameParts.slice(1).join('.');
    // oxlint-disable-next-line @typescript-eslint/only-throw-error -- React Router pattern: throwing Response is valid
    throw redirect(url.toString(), statusCode);
  }
}
