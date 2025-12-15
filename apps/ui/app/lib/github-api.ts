import { Octokit } from '@octokit/rest';
import { metaConfig } from '#constants/meta.constants.js';
import { ENV } from '#config.js';

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
      nodes: Array<{
        name: string;
        target: {
          oid: string;
          committedDate?: string;
        };
      }>;
    };
  };
};

/**
 * GitHub API client singleton
 * Provides authenticated access to GitHub API with proper typing
 */
class GitHubApiClient {
  public static getInstance(auth?: string): GitHubApiClient {
    GitHubApiClient.instance ??= new GitHubApiClient(auth);
    return GitHubApiClient.instance;
  }

  private static instance: GitHubApiClient | undefined;

  private readonly octokit: Octokit;

  private constructor(auth?: string) {
    this.octokit = new Octokit({
      auth,
      userAgent: metaConfig.userAgent,
    });
  }

  /**
   * Get repository metadata
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
  }

  /**
   * Get list of branches for a repository with commit timestamps
   * Uses GraphQL API to fetch ALL branches with their last commit date
   * Since GitHub's TAG_COMMIT_DATE ordering only works for tags (not branches),
   * we fetch all branches and sort client-side by commit date
   * The default branch is always fetched and included at the start
   */
  public async listBranches(
    owner: string,
    repo: string,
    _page = 1,
    cursor?: string,
  ): Promise<{
    branches: Array<{ name: string; sha: string; updatedAt: number }>;
    hasMore: boolean;
    endCursor: string | undefined;
  }> {
    // Fetch all branches by paginating through all results
    // GitHub's refs API doesn't properly sort branches by commit date,
    // so we need to fetch all and sort client-side
    const allBranches: Array<{ name: string; sha: string; updatedAt: number }> = [];
    let currentCursor: string | undefined = cursor;
    let hasNextPage = true;
    let defaultBranchName: string | undefined;

    // For the first page, also fetch the default branch info
    const isFirstPage = cursor === undefined;

    while (hasNextPage) {
      const query =
        isFirstPage && allBranches.length === 0
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

      type BranchesWithDefaultResponse = BranchesGraphqlResponse & {
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

      // eslint-disable-next-line no-await-in-loop -- intentional pagination
      const response = await this.octokit.graphql<BranchesWithDefaultResponse>(query, {
        owner,
        repo,
        first: 100,
        after: currentCursor,
      });

      // Capture default branch name on first request
      if (isFirstPage && allBranches.length === 0 && response.repository.defaultBranchRef) {
        defaultBranchName = response.repository.defaultBranchRef.name;
      }

      const branches = response.repository.refs.nodes
        .filter((node) => node.target.committedDate !== undefined)
        .map((node) => ({
          name: node.name,
          sha: node.target.oid,
          updatedAt: new Date(node.target.committedDate!).getTime(),
        }));

      allBranches.push(...branches);

      hasNextPage = response.repository.refs.pageInfo.hasNextPage;
      currentCursor = response.repository.refs.pageInfo.endCursor ?? undefined;
    }

    // Sort all branches by commit date (most recent first)
    allBranches.sort((a, b) => b.updatedAt - a.updatedAt);

    // Move default branch to the start if it exists
    if (defaultBranchName) {
      const defaultBranchIndex = allBranches.findIndex((b) => b.name === defaultBranchName);
      if (defaultBranchIndex > 0) {
        const defaultBranch = allBranches[defaultBranchIndex];
        if (defaultBranch) {
          allBranches.splice(defaultBranchIndex, 1);
          allBranches.unshift(defaultBranch);
        }
      }
    }

    // Since we fetch all branches at once, there's no more to load
    return {
      branches: allBranches,
      hasMore: false,
      endCursor: undefined,
    };
  }

  /**
   * List files in a repository tree (without downloading content)
   * Uses the Git Trees API with recursive option
   * Filters to only include files (blobs), not directories (trees)
   */
  public async listFiles(owner: string, repo: string, ref: string): Promise<Array<{ path: string; size: number }>> {
    // Get the tree for the ref
    const { data } = await this.octokit.git.getTree({
      owner,
      repo,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub API uses snake_case
      tree_sha: ref,
      recursive: 'true',
    });

    // Filter to only blobs (files) and map to path/size
    return data.tree
      .filter((item) => item.type === 'blob')
      .map((item) => ({
        path: item.path,
        size: item.size ?? 0,
      }));
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
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number | undefined }> {
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
