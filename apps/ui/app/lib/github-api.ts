import { Octokit } from '@octokit/rest';
import { metaConfig } from '#constants/meta.constants.js';
import { ENV } from '#environment.config.js';

/**
 * Branch node from GraphQL response
 */
type BranchNode = {
  name: string;
  target: {
    oid: string;
    committedDate?: string;
  };
};

/**
 * GraphQL response type for branches query
 */
type BranchesGraphqlResponse = {
  repository: {
    refs: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | undefined;
      };
      nodes: BranchNode[];
    };
  };
};

/**
 * GraphQL response type for branches query with default branch info
 * Used on the first page request to include the repository's default branch
 */
export type BranchesWithDefaultResponse = BranchesGraphqlResponse & {
  repository: {
    defaultBranchRef?: {
      name: string;
      target: {
        oid: string;
        committedDate?: string;
      };
    };
  };
};

/**
 * Error thrown when GitHub's Git Trees API returns a truncated response.
 * This occurs when the repository tree exceeds ~100,000 entries or 7MB response size.
 *
 * Callers should catch this error and implement alternative strategies:
 * - Use Repository Contents API for incremental directory traversal
 * - Use GraphQL API with pagination
 * - Clone the repository locally
 * - Filter to a specific subdirectory
 */
export class GitHubTreeTruncatedError extends Error {
  public readonly owner: string;
  public readonly repo: string;
  public readonly ref: string;
  public readonly partialCount: number;

  public constructor(owner: string, repo: string, ref: string, partialCount: number, message: string) {
    super(message);
    this.name = 'GitHubTreeTruncatedError';
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.partialCount = partialCount;
  }
}

/**
 * Check if an error is a 401 Unauthorized error
 */
function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Check for 401 status code or common 401 error messages
    return (
      message.includes('401') ||
      message.includes('unauthorized') ||
      message.includes('bad credentials') ||
      message.includes('requires authentication')
    );
  }

  return false;
}

/**
 * GitHub API client singleton
 * Provides authenticated access to GitHub API with proper typing
 *
 * When a 401 error occurs with an authenticated client, the client will
 * automatically retry the request without authentication. This allows
 * fetching public repository information even when the token is invalid.
 */
class GitHubApiClient {
  public static getInstance(auth?: string): GitHubApiClient {
    GitHubApiClient.instance ??= new GitHubApiClient(auth);
    return GitHubApiClient.instance;
  }

  /**
   * Get an unauthenticated client instance for retrying after 401 errors.
   * This bypasses the singleton to ensure no auth token is used.
   */
  public static getUnauthenticatedInstance(): GitHubApiClient {
    return new GitHubApiClient(undefined);
  }

  private static instance: GitHubApiClient | undefined;

  private readonly octokit: Octokit;
  private readonly hasAuth: boolean;

  private constructor(auth?: string) {
    this.octokit = new Octokit({
      auth,
      userAgent: metaConfig.userAgent,
    });
    this.hasAuth = auth !== undefined && auth.length > 0;
  }

  /**
   * Get repository metadata
   *
   * If authenticated and a 401 error occurs, automatically retries without authentication
   * to fetch public repository information.
   */
  public async getRepository(
    owner: string,
    repo: string,
  ): Promise<{
    avatarUrl: string | undefined;
    description: string | undefined;
    stars: number;
    forks: number;
    watchers: number;
    license: string | undefined;
    defaultBranch: string;
    isPrivate: boolean;
    lastUpdated: string;
  }> {
    try {
      const { data } = await this.octokit.repos.get({
        owner,
        repo,
      });

      return {
        avatarUrl: data.owner.avatar_url,
        description: data.description ?? undefined,
        stars: data.stargazers_count,
        forks: data.forks_count,
        watchers: data.watchers_count,
        license: data.license?.spdx_id ?? undefined,
        defaultBranch: data.default_branch,
        isPrivate: data.private,
        lastUpdated: data.updated_at,
      };
    } catch (error) {
      // If we have auth and got a 401, retry without auth for public repos
      if (this.hasAuth && isUnauthorizedError(error)) {
        const unauthClient = GitHubApiClient.getUnauthenticatedInstance();
        return unauthClient.getRepository(owner, repo);
      }

      throw error;
    }
  }

  /**
   * Get list of branches for a repository with commit timestamps
   * Uses GraphQL API with cursor-based pagination
   * On the first page (no cursor), the default branch is included and placed first
   * Branches within each page are sorted by commit date (most recent first)
   *
   * Note: Cross-page sorting by commit date is not possible since GitHub's
   * TAG_COMMIT_DATE ordering only works for tags. Consider fetching all pages
   * client-side if full sorting is required.
   *
   * Note: The GraphQL API requires authentication. If a 401 error occurs,
   * this method will throw a clean error that can be handled gracefully by the UI.
   */
  public async listBranches(
    owner: string,
    repo: string,
    pageSize = 100,
    cursor?: string,
  ): Promise<{
    branches: Array<{ name: string; sha: string; updatedAt: number }>;
    hasMore: boolean;
    endCursor: string | undefined;
  }> {
    const isFirstPage = cursor === undefined;

    // On first page, also fetch the default branch info
    const query = isFirstPage
      ? `
          query($owner: String!, $repo: String!, $first: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              defaultBranchRef {
                name
                target {
                  ... on Commit {
                    oid
                    committedDate
                  }
                }
              }
              refs(refPrefix: "refs/heads/", first: $first, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  name
                  target {
                    ... on Commit {
                      oid
                      committedDate
                    }
                  }
                }
              }
            }
          }
        `
      : `
          query($owner: String!, $repo: String!, $first: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              refs(refPrefix: "refs/heads/", first: $first, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  name
                  target {
                    ... on Commit {
                      oid
                      committedDate
                    }
                  }
                }
              }
            }
          }
        `;

    try {
      const response = await this.octokit.graphql<BranchesWithDefaultResponse>(query, {
        owner,
        repo,
        first: pageSize,
        after: cursor,
      });

      // Type guard to check if a branch node has a valid committed date
      const hasCommittedDate = (
        node: BranchNode,
      ): node is BranchNode & { target: { oid: string; committedDate: string } } => {
        return node.target.committedDate !== undefined;
      };

      // Map branches, filtering out those without commit dates
      const branches = response.repository.refs.nodes
        .filter((node) => hasCommittedDate(node))
        .map((node) => ({
          name: node.name,
          sha: node.target.oid,
          updatedAt: new Date(node.target.committedDate).getTime(),
        }));

      // Sort branches within this page by commit date (most recent first)
      branches.sort((a, b) => b.updatedAt - a.updatedAt);

      // On first page, move default branch to the start if it exists
      if (isFirstPage && response.repository.defaultBranchRef) {
        const defaultBranchName = response.repository.defaultBranchRef.name;
        const defaultBranchIndex = branches.findIndex((b) => b.name === defaultBranchName);
        if (defaultBranchIndex > 0) {
          const defaultBranch = branches[defaultBranchIndex];
          if (defaultBranch) {
            branches.splice(defaultBranchIndex, 1);
            branches.unshift(defaultBranch);
          }
        }
      }

      return {
        branches,
        hasMore: response.repository.refs.pageInfo.hasNextPage,
        endCursor: response.repository.refs.pageInfo.endCursor,
      };
    } catch (error) {
      // Convert 401 errors to a cleaner error message
      if (isUnauthorizedError(error)) {
        throw new Error('401 Unauthorized: GitHub API token is invalid or expired. Branches list unavailable.');
      }

      throw error;
    }
  }

  /**
   * List files in a repository tree (without downloading content)
   * Uses the Git Trees API with recursive option
   * Filters to only include files (blobs), not directories (trees)
   *
   * If authenticated and a 401 error occurs, automatically retries without authentication
   * to fetch public repository file listings.
   *
   * @throws {GitHubTreeTruncatedError} When the tree is too large (>100k entries or >7MB response)
   *         and GitHub returns a truncated result. Callers should handle this error and consider
   *         alternative strategies for large repositories.
   */
  public async listFiles(owner: string, repo: string, ref: string): Promise<Array<{ path: string; size: number }>> {
    try {
      // Get the tree for the ref
      const { data } = await this.octokit.git.getTree({
        owner,
        repo,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub API uses snake_case
        tree_sha: ref,
        recursive: 'true',
      });

      // Check if the tree response was truncated due to size limits
      // GitHub truncates trees exceeding ~100,000 entries or 7MB response size
      if (data.truncated) {
        throw new GitHubTreeTruncatedError(
          owner,
          repo,
          ref,
          data.tree.length,
          'The repository tree is too large and was truncated by GitHub. ' +
            'Consider using one of the following alternative strategies:\n' +
            '1. Use the Repository Contents API to traverse directories incrementally\n' +
            '2. Use the GraphQL API with pagination for more control\n' +
            '3. Clone the repository locally using git\n' +
            '4. Filter to a specific subdirectory if you only need part of the tree',
        );
      }

      // Filter to only blobs (files) and map to path/size
      return data.tree
        .filter((item) => item.type === 'blob')
        .map((item) => ({
          path: item.path,
          size: item.size ?? 0,
        }));
    } catch (error) {
      // If we have auth and got a 401, retry without auth for public repos
      if (this.hasAuth && isUnauthorizedError(error)) {
        const unauthClient = GitHubApiClient.getUnauthenticatedInstance();
        return unauthClient.listFiles(owner, repo, ref);
      }

      throw error;
    }
  }

  /**
   * Download repository archive as a stream with size information
   * Uses proxy to avoid CORS issues
   * Returns both the stream and the content length from the response headers
   *
   * Note: GitHub API returns Content-Length header when using full refs like refs/heads/main
   */
  public async downloadArchiveWithSize(
    owner: string,
    repo: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ stream: ReadableStream<Uint8Array<ArrayBuffer>>; size: number | undefined }> {
    // Convert short ref to full ref for GitHub API (required for Content-Length header)
    // refs/heads/main, refs/tags/v1.0, etc work; short refs like "main" don't return Content-Length
    const fullRef = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;

    // Use GitHub API endpoint (not direct codeload.github.com) to get Content-Length header
    const zipUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${fullRef}`;
    // Use proxy endpoint to avoid CORS issues
    const proxyUrl = `/api/import?url=${encodeURIComponent(zipUrl)}`;

    const response = await fetch(proxyUrl, {
      headers: {
        'User-Agent': metaConfig.userAgent,
        accept: 'application/vnd.github.v3+json',
        // Request uncompressed to get accurate size
        'Accept-Encoding': 'identity',
      },
      redirect: 'follow',
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to download archive: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    // Get content length from the GET response
    const contentLengthHeader = response.headers.get('Content-Length');
    const size = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;

    return {
      stream: response.body,
      size,
    };
  }
}

/**
 * Get GitHub API client instance
 * Pass token from environment variable or config
 */
export function getGitHubClient(): GitHubApiClient {
  return GitHubApiClient.getInstance(ENV.GITHUB_API_TOKEN);
}
