import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGitHubClient } from '#lib/github-api.js';

vi.mock('#environment.config.js', () => {
  /* eslint-disable @typescript-eslint/naming-convention -- mock env object shape */
  const mock = {
    ENV: { GITHUB_API_TOKEN: undefined },
  };
  /* eslint-enable @typescript-eslint/naming-convention -- mock env object shape */
  return mock;
});

describe('GitHubApiClient', () => {
  let client: ReturnType<typeof getGitHubClient>;

  beforeEach(() => {
    client = getGitHubClient();
  });

  // ---------------------------------------------------------------------------
  // getArchiveUrl
  // ---------------------------------------------------------------------------

  describe('getArchiveUrl', () => {
    it('should return a proxied URL with fully qualified ref', () => {
      const url = client.getArchiveUrl({ owner: 'myorg', repo: 'myrepo', ref: 'main' });

      expect(url).toContain('/api/import?url=');
      expect(url).toContain(encodeURIComponent('refs/heads/main'));
      expect(url).toContain(encodeURIComponent('myorg'));
      expect(url).toContain(encodeURIComponent('myrepo'));
    });

    it('should preserve refs/ prefix when already present', () => {
      const url = client.getArchiveUrl({ owner: 'o', repo: 'r', ref: 'refs/tags/v1.0' });

      expect(url).toContain(encodeURIComponent('refs/tags/v1.0'));
      expect(url).not.toContain(encodeURIComponent('refs/heads/refs/tags/v1.0'));
    });

    it('should encode special characters in owner and repo', () => {
      const url = client.getArchiveUrl({ owner: 'my org', repo: 'my repo', ref: 'main' });

      expect(url).toContain(encodeURIComponent('my%20org'));
    });
  });

  // ---------------------------------------------------------------------------
  // getAuthHeaders
  // ---------------------------------------------------------------------------

  describe('getAuthHeaders', () => {
    it('should return headers with User-Agent', () => {
      const headers = client.getAuthHeaders();

      expect(headers).toEqual(
        expect.objectContaining({
          'User-Agent': expect.any(String) as string,
          accept: 'application/vnd.github.v3+json',
          'Accept-Encoding': 'identity',
        }),
      );
    });

    it('should return a non-empty User-Agent', () => {
      const headers = client.getAuthHeaders();
      expect(headers['User-Agent']!.length).toBeGreaterThan(0);
    });
  });
});
