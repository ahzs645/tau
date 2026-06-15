import process from 'node:process';
import type { LoaderFunction } from 'react-router';

export type AppVersion = {
  readonly commit: string | null;
  readonly builtAt: string | null;
};

export const loader: LoaderFunction = () =>
  Response.json(
    {
      commit: process.env['VITE_COMMIT_SHA'] ?? process.env['GITHUB_SHA'] ?? null,
      builtAt: process.env['VITE_BUILD_TIME'] ?? process.env['BUILD_TIME'] ?? null,
    } satisfies AppVersion,
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
