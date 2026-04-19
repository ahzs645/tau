import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyResponse,
  checkUrl,
  checkUrlsConcurrently,
  checkWithCache,
  readCache,
  writeCache,
} from './external-link-checker.js';

/** @param {number} status */
const mockResponse = (status) => /** @type {Response} */ ({ status, ok: status >= 200 && status < 300 });

/** @param {Record<number, number>} methodStatusMap - maps: 0=HEAD, 1=GET */
const createMockFetch = (methodStatusMap) => {
  let callCount = 0;
  return vi.fn(async () => {
    const status = methodStatusMap[callCount] ?? 200;
    callCount++;
    return mockResponse(status);
  });
};

describe('external-link-checker', () => {
  describe('classifyResponse', () => {
    it('should classify 2xx as alive', () => {
      expect(classifyResponse('https://a.com', 200).status).toBe('alive');
      expect(classifyResponse('https://a.com', 301).status).toBe('alive');
    });

    it('should classify 404 and 410 as dead', () => {
      expect(classifyResponse('https://a.com', 404).status).toBe('dead');
      expect(classifyResponse('https://a.com', 410).status).toBe('dead');
    });

    it('should classify 429 as alive (rate-limited)', () => {
      const result = classifyResponse('https://a.com', 429);
      expect(result.status).toBe('alive');
      expect(result.statusCode).toBe(429);
    });

    it('should classify 5xx as error', () => {
      const result = classifyResponse('https://a.com', 500);
      expect(result.status).toBe('error');
      expect(result.error).toBe('HTTP 500');
    });
  });

  describe('checkUrl', () => {
    it('should return alive for 200 HEAD response', async () => {
      const fetchFunction = vi.fn(async () => mockResponse(200));
      const result = await checkUrl('https://example.com', fetchFunction);
      expect(result.status).toBe('alive');
      expect(result.statusCode).toBe(200);
      expect(fetchFunction).toHaveBeenCalledTimes(1);
    });

    it('should fall back to GET on 405 HEAD response', async () => {
      const fetchFunction = createMockFetch({ 0: 405, 1: 200 });
      const result = await checkUrl('https://example.com', fetchFunction);
      expect(result.status).toBe('alive');
      expect(result.statusCode).toBe(200);
      expect(fetchFunction).toHaveBeenCalledTimes(2);
    });

    it('should fall back to GET on 403 HEAD response', async () => {
      const fetchFunction = createMockFetch({ 0: 403, 1: 200 });
      const result = await checkUrl('https://example.com', fetchFunction);
      expect(result.status).toBe('alive');
      expect(fetchFunction).toHaveBeenCalledTimes(2);
    });

    it('should report dead for 404 response', async () => {
      const fetchFunction = vi.fn(async () => mockResponse(404));
      const result = await checkUrl('https://dead.com', fetchFunction);
      expect(result.status).toBe('dead');
      expect(result.statusCode).toBe(404);
    });

    it('should return error on network failure', async () => {
      const fetchFunction = vi.fn(async () => {
        throw new Error('DNS resolution failed');
      });
      const result = await checkUrl('https://no-exist.com', fetchFunction);
      expect(result.status).toBe('error');
      expect(result.error).toBe('DNS resolution failed');
    });
  });

  describe('checkUrlsConcurrently', () => {
    it('should check multiple URLs', async () => {
      const responses = {
        'https://a.com': 200,
        'https://b.com': 404,
        'https://c.com': 200,
      };
      const fetchFunction = vi.fn(async (/** @type {string} */ url) => mockResponse(responses[url] ?? 500));

      const results = await checkUrlsConcurrently(Object.keys(responses), 5, fetchFunction);
      expect(results).toHaveLength(3);

      const alive = results.filter((r) => r.status === 'alive');
      const dead = results.filter((r) => r.status === 'dead');
      expect(alive).toHaveLength(2);
      expect(dead).toHaveLength(1);
    });

    it('should respect concurrency limit', async () => {
      let activeCalls = 0;
      let maxActiveCalls = 0;

      const fetchFunction = vi.fn(async () => {
        activeCalls++;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        activeCalls--;
        return mockResponse(200);
      });

      const urls = Array.from({ length: 10 }, (_, index) => `https://example${index}.com`);
      await checkUrlsConcurrently(urls, 3, fetchFunction);
      expect(maxActiveCalls).toBeLessThanOrEqual(3);
    });
  });

  describe('cache', () => {
    const temporaryDirectory = path.join(import.meta.dirname, '__test_cache__');
    const cacheFile = path.join(temporaryDirectory, 'test-cache.json');

    beforeEach(() => {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true });
      } catch {
        // Doesn't exist yet
      }
    });

    it('should return empty object for nonexistent cache', () => {
      expect(readCache('/nonexistent/path.json')).toEqual({});
    });

    it('should write and read cache', () => {
      const cache = {
        'https://a.com': { status: /** @type {const} */ ('alive'), statusCode: 200, checkedAt: Date.now() },
      };
      writeCache(cacheFile, cache);
      const read = readCache(cacheFile);
      expect(read['https://a.com'].status).toBe('alive');

      fs.rmSync(temporaryDirectory, { recursive: true });
    });

    it('should use cached results within TTL', async () => {
      const fetchFunction = vi.fn(async () => mockResponse(200));

      await checkWithCache({
        urls: ['https://cached.com'],
        cacheFile,
        ttlMs: 60_000,
        fetchFunction,
      });
      expect(fetchFunction).toHaveBeenCalledTimes(1);

      const results = await checkWithCache({
        urls: ['https://cached.com'],
        cacheFile,
        ttlMs: 60_000,
        fetchFunction,
      });
      expect(fetchFunction).toHaveBeenCalledTimes(1);
      expect(results[0].status).toBe('alive');

      fs.rmSync(temporaryDirectory, { recursive: true });
    });

    it('should re-check when cache is expired', async () => {
      const fetchFunction = vi.fn(async () => mockResponse(200));

      await checkWithCache({
        urls: ['https://expired.com'],
        cacheFile,
        ttlMs: 0,
        fetchFunction,
      });
      expect(fetchFunction).toHaveBeenCalledTimes(1);

      await checkWithCache({
        urls: ['https://expired.com'],
        cacheFile,
        ttlMs: 0,
        fetchFunction,
      });
      expect(fetchFunction).toHaveBeenCalledTimes(2);

      fs.rmSync(temporaryDirectory, { recursive: true });
    });

    it('should return empty array for empty URLs', async () => {
      const results = await checkWithCache({
        urls: [],
        cacheFile,
        ttlMs: 60_000,
      });
      expect(results).toEqual([]);
    });
  });
});
