import type { ReactNode } from 'react';

export type ConsentStatus = 'pending' | 'granted' | 'denied';

/** Minimal analytics contract used by UI call sites in the tracking-free static build. */
/* eslint-disable @typescript-eslint/naming-convention -- mirrors the PostHog-shaped API used by call sites */
export type Analytics = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  captureException: (error: unknown, properties?: Record<string, unknown>) => void;
  get_explicit_consent_status: () => 'granted' | 'denied' | undefined;
  opt_in_capturing: () => void;
  opt_out_capturing: () => void;
};

const noop = (): void => undefined;

const staticAnalytics: Analytics = {
  capture: noop,
  captureException: noop,
  get_explicit_consent_status: () => 'denied',
  opt_in_capturing: noop,
  opt_out_capturing: noop,
};
/* eslint-enable @typescript-eslint/naming-convention -- re-enable after the compatibility contract */

export const useAnalytics = (): Analytics => staticAnalytics;

export const useCookieConsent = (): [ConsentStatus, (status: ConsentStatus) => void] => ['denied', noop];

export const DeferredSessionRecording = (): ReactNode => undefined;

export const AnalyticsProvider = ({ children }: { readonly children: ReactNode }): ReactNode => children;
