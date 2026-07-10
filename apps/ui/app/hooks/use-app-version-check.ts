import { useEffect } from 'react';
import { toast } from '#components/ui/sonner.js';

export type AppVersion = {
  readonly version?: unknown;
  readonly buildNumber?: unknown;
  readonly commit?: unknown;
  readonly commitSha?: unknown;
  readonly builtAt?: unknown;
  readonly buildTime?: unknown;
};

const updateToastId = 'app-version-update-available';
const secondsPerMinute = 60;
const millisecondsPerSecond = 10 ** 3;
const updateCheckInterval = 5 * secondsPerMinute * millisecondsPerSecond;
const initialCheckDelay = 2 * millisecondsPerSecond;
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '::1']);

const hasUsableBuildNumber = (buildNumber: string | undefined): buildNumber is string =>
  buildNumber !== undefined && buildNumber.length > 0 && buildNumber !== 'dev';

const hasUsableCommit = (commit: string | undefined): commit is string =>
  commit !== undefined && commit.length > 0 && commit !== 'dev';

const isLocalDevServer = (): boolean => {
  if (import.meta.env['VITE_ENABLE_DEV_UPDATE_CHECKS'] === 'true') {
    return false;
  }

  if (import.meta.env.DEV) {
    return true;
  }

  return loopbackHostnames.has(globalThis.location.hostname);
};

const getVersionJsonHref = (): string => {
  const frontendUrl = globalThis.window.ENV.TAU_FRONTEND_URL;

  if (typeof frontendUrl !== 'string') {
    return '/version.json';
  }

  try {
    const { pathname } = new URL(frontendUrl);
    const publicBasePath = pathname === '/' ? '' : pathname.replace(/\/$/, '');
    return `${publicBasePath}/version.json`;
  } catch {
    return '/version.json';
  }
};

const fetchLatestVersion = async (): Promise<AppVersion | undefined> => {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-cache');
  headers.set('Pragma', 'no-cache');

  const response = await fetch(`${getVersionJsonHref()}?ts=${Date.now()}`, {
    cache: 'no-store',
    headers,
  });

  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as AppVersion;
};

const getVersionBuildNumber = (version: AppVersion): string | undefined => {
  if (typeof version.buildNumber === 'string' && version.buildNumber.length > 0) {
    return version.buildNumber;
  }

  const commit = version.commitSha ?? version.commit;
  if (typeof commit === 'string' && commit.length > 0) {
    return commit.slice(0, 7);
  }

  return undefined;
};

const getVersionCommit = (version: AppVersion): string | undefined => {
  const commit = version.commitSha ?? version.commit;
  return typeof commit === 'string' && commit.length > 0 ? commit : undefined;
};

const reloadWithCacheBust = (): void => {
  const url = new URL(globalThis.location.href);
  url.searchParams.set('_cb', Date.now().toString());
  globalThis.location.href = url.toString();
};

const removeCacheBustParameter = (): void => {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has('_cb')) {
    return;
  }

  url.searchParams.delete('_cb');
  globalThis.history.replaceState({}, '', url.toString());
};

export const useAppVersionCheck = (): void => {
  useEffect(() => {
    if (isLocalDevServer()) {
      return;
    }

    const currentBuildNumber = globalThis.window.tauBuildMetadata?.buildNumber;
    if (!hasUsableBuildNumber(currentBuildNumber)) {
      return;
    }
    const currentCommit = globalThis.window.tauBuildMetadata?.commit;

    removeCacheBustParameter();

    let cancelled = false;

    const checkForUpdate = async (): Promise<void> => {
      try {
        const latestVersion = await fetchLatestVersion();
        if (!latestVersion || cancelled) {
          return;
        }

        const latestBuildNumber = getVersionBuildNumber(latestVersion);
        const latestCommit = getVersionCommit(latestVersion);
        const isCurrent =
          hasUsableCommit(currentCommit) && hasUsableCommit(latestCommit)
            ? latestCommit === currentCommit
            : latestBuildNumber === currentBuildNumber;
        if (!hasUsableBuildNumber(latestBuildNumber) || isCurrent) {
          return;
        }

        toast.info('New version available', {
          id: updateToastId,
          description: 'Refresh to use the latest Tau build.',
          action: {
            label: 'Refresh',
            onClick: reloadWithCacheBust,
          },
          duration: Number.POSITIVE_INFINITY,
        });
      } catch {
        // Version checks are best-effort so cached app shells remain usable offline.
      }
    };

    const initialCheckTimer = globalThis.setTimeout(() => {
      void checkForUpdate();
    }, initialCheckDelay);
    const updateCheckTimer = globalThis.setInterval(() => {
      void checkForUpdate();
    }, updateCheckInterval);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(initialCheckTimer);
      globalThis.clearInterval(updateCheckTimer);
    };
  }, []);
};
