#!/usr/bin/env node
/**
 * Subprocess that checks external URLs for liveness.
 *
 * Protocol:
 *   stdin  → JSON array of URL strings
 *   stdout → JSON array of { url, status, statusCode?, error? }
 *
 * Uses a disk cache at node_modules/.cache/tau-lint/external-links.json
 * with a configurable TTL (default 24 hours) to avoid repeated network requests.
 */

import fs from 'node:fs';
import path from 'node:path';

const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (compatible; TauLinkChecker/1.0)';

/**
 * @typedef {{ status: 'alive' | 'dead' | 'error'; statusCode?: number; checkedAt: number; error?: string }} CacheEntry
 * @typedef {{ url: string; status: 'alive' | 'dead' | 'error'; statusCode?: number; error?: string }} CheckResult
 */

/**
 * @param {string} url
 * @param {number} statusCode
 * @returns {CheckResult}
 */
export const classifyResponse = (url, statusCode) => {
  if (statusCode >= 200 && statusCode < 400) {
    return { url, status: 'alive', statusCode };
  }
  if (statusCode === 429) {
    return { url, status: 'alive', statusCode };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { url, status: 'dead', statusCode };
  }
  return { url, status: 'error', statusCode, error: `HTTP ${statusCode}` };
};

/**
 * @param {string} url
 * @param {typeof globalThis.fetch} fetchFunction
 * @returns {Promise<CheckResult>}
 */
export const checkUrl = async (url, fetchFunction = globalThis.fetch) => {
  try {
    const headResponse = await fetchFunction(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (headResponse.status === 405 || headResponse.status === 403) {
      const getResponse = await fetchFunction(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return classifyResponse(url, getResponse.status);
    }

    return classifyResponse(url, headResponse.status);
  } catch (/** @type {any} */ error) {
    return { url, status: 'error', error: error?.message ?? 'Unknown error' };
  }
};

/**
 * @param {string[]} urls
 * @param {number} concurrency
 * @param {typeof globalThis.fetch} [fetchFunction]
 * @returns {Promise<CheckResult[]>}
 */
export const checkUrlsConcurrently = async (urls, concurrency, fetchFunction) => {
  /** @type {CheckResult[]} */
  const results = [];
  const queue = [...urls];

  // Each worker processes its own queue slice sequentially while multiple
  // workers run in parallel via Promise.allSettled — intentional sequential await.
  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (url) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential within each concurrent worker is intended
        results.push(await checkUrl(url, fetchFunction));
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => worker());
  await Promise.allSettled(workers);
  return results;
};

/**
 * @param {string} cacheFile
 * @returns {Record<string, CacheEntry>}
 */
export const readCache = (cacheFile) => {
  try {
    /** @type {Record<string, CacheEntry>} */
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed;
  } catch {
    return {};
  }
};

/**
 * @param {string} cacheFile
 * @param {Record<string, CacheEntry>} cache
 */
export const writeCache = (cacheFile, cache) => {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
};

/**
 * @param {{ urls: string[]; cacheFile: string; ttlMs: number; fetchFunction?: typeof globalThis.fetch }} options
 * @returns {Promise<CheckResult[]>}
 */
export const checkWithCache = async ({ urls, cacheFile, ttlMs, fetchFunction }) => {
  if (urls.length === 0) {
    return [];
  }

  const cache = readCache(cacheFile);
  const now = Date.now();

  /** @type {CheckResult[]} */
  const allResults = [];
  /** @type {string[]} */
  const urlsToCheck = [];

  for (const url of urls) {
    const cached = cache[url];
    if (cached && now - cached.checkedAt < ttlMs) {
      allResults.push({
        url,
        status: cached.status,
        statusCode: cached.statusCode,
        error: cached.error,
      });
    } else {
      urlsToCheck.push(url);
    }
  }

  if (urlsToCheck.length > 0) {
    const freshResults = await checkUrlsConcurrently(urlsToCheck, CONCURRENCY, fetchFunction);

    for (const result of freshResults) {
      allResults.push(result);
      cache[result.url] = {
        status: result.status,
        statusCode: result.statusCode,
        checkedAt: now,
        error: result.error,
      };
    }

    writeCache(cacheFile, cache);
  }

  return allResults;
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMainModule) {
  const workspaceRoot = process.env.NX_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '..', '..', '..');
  const cacheDirectory = path.join(workspaceRoot, 'node_modules', '.cache', 'tau-lint');
  const cacheFile = path.join(cacheDirectory, 'external-links.json');
  const ttlMs = Number(process.env.MDX_EXTERNAL_LINK_TTL_MS) || DEFAULT_TTL_MS;

  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }

  /** @type {string[]} */
  const urls = JSON.parse(input);
  const results = await checkWithCache({ urls, cacheFile, ttlMs });
  process.stdout.write(JSON.stringify(results));
}
