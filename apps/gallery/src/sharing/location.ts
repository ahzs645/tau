import { useSyncExternalStore } from 'react';
import { base64ToString, stringToBase64 } from 'uint8array-extras';

const locationEvent = 'tau-gallery-location';
const maximumTokenLength = 65_536;

export type GalleryLocation = {
  readonly modelId?: string;
  readonly variantId?: string;
  readonly parameters: Record<string, unknown>;
  readonly hasParameters: boolean;
  readonly parameterError?: string;
  readonly isGallery: boolean;
};

const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 16) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).every(
    ([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(item, depth + 1),
  );
};

/** Keep the fork's version-one links byte compatible, including Unicode parameters. */
export const encodeParameters = (parameters: Record<string, unknown>): string => {
  if (!isJsonValue(parameters)) {
    throw new TypeError('Parameters must contain JSON values.');
  }
  const token = `1.raw.${stringToBase64(JSON.stringify(parameters), { urlSafe: true }).replace(/=+$/, '')}`;
  if (token.length > maximumTokenLength) {
    throw new RangeError('These parameters are too large for a share link.');
  }
  return token;
};

export const decodeParameters = (token: string): Record<string, unknown> => {
  if (token.length > maximumTokenLength) {
    throw new RangeError('The parameter link is too large.');
  }
  if (!token.startsWith('1.raw.')) {
    throw new TypeError('This parameter link uses an unsupported format.');
  }
  const parsed: unknown = JSON.parse(base64ToString(token.slice(6)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !isJsonValue(parsed)) {
    throw new TypeError('The parameter link does not contain valid model parameters.');
  }
  return Object.fromEntries(Object.entries(parsed));
};

/** Resolve deployed root URLs and both historical playground URL forms. */
export const readGalleryLocation = (url: URL): GalleryLocation => {
  const path = url.pathname.replace(/^\/tau(?=\/|$)/, '').replaceAll(/^\/+|\/+$/g, '');
  const legacyModel = url.searchParams.get('model') ?? url.searchParams.get('example');
  const isGallery = (!path || path === 'gallery') && !legacyModel;
  const candidate = path === 'playground' || !path || path === 'gallery' ? legacyModel : path;
  let modelId: string | undefined;
  try {
    modelId = candidate ? decodeURIComponent(candidate) : undefined;
  } catch {
    modelId = candidate ?? undefined;
  }
  const token = url.searchParams.get('p');
  const base = {
    modelId,
    variantId: url.searchParams.get('variant') ?? undefined,
    isGallery,
    hasParameters: token !== null,
  };
  try {
    return { ...base, parameters: token ? decodeParameters(token) : {} };
  } catch (error) {
    return {
      ...base,
      parameters: {},
      parameterError: error instanceof Error ? error.message : 'The parameter link could not be read.',
    };
  }
};

export const modelUrl = (
  modelId: string,
  options: { readonly variantId?: string; readonly parameters?: Record<string, unknown>; readonly base?: URL } = {},
): URL => {
  const url = new URL(options.base?.href ?? 'https://3dd.ahmadjalil.com/');
  url.pathname = `/${encodeURIComponent(modelId)}`;
  url.searchParams.delete('model');
  url.searchParams.delete('example');
  if (options.variantId) {
    url.searchParams.set('variant', options.variantId);
  } else {
    url.searchParams.delete('variant');
  }
  if (options.parameters === undefined) {
    url.searchParams.delete('p');
  } else {
    url.searchParams.set('p', encodeParameters(options.parameters));
  }
  return url;
};

export const navigate = (url: URL | string, replace = false): void => {
  const target = new URL(url, globalThis.location.href);
  if (target.origin !== globalThis.location.origin) {
    throw new TypeError('Gallery navigation must stay on this site.');
  }
  if (replace) {
    globalThis.history.replaceState(null, '', target);
  } else {
    globalThis.history.pushState(null, '', target);
  }
  globalThis.dispatchEvent(new Event(locationEvent));
};

const subscribe = (listener: () => void): (() => void) => {
  globalThis.addEventListener('popstate', listener);
  globalThis.addEventListener(locationEvent, listener);
  return () => {
    globalThis.removeEventListener('popstate', listener);
    globalThis.removeEventListener(locationEvent, listener);
  };
};
const currentHref = (): string => globalThis.location.href;

export const useGalleryHref = (): string =>
  useSyncExternalStore(subscribe, currentHref, () => 'https://3dd.ahmadjalil.com/');
