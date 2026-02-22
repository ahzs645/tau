import { useCallback, useContext, useEffect, useState, useMemo, useRef } from 'react';
import type { ActorRefFrom } from 'xstate';
import { AuthUIContext } from '@daveyplate/better-auth-ui';
import { GitBranch, User, MoreHorizontal } from 'lucide-react';
import type { GitRepository } from '@taucad/types';
import { Loader } from '#components/ui/loader.js';
import type { gitMachine } from '#machines/git.machine.js';
import { Button } from '#components/ui/button.js';
import { toast } from '#components/ui/sonner.js';
import { getGitHubAccessToken } from '#lib/git-auth.js';
import { cn } from '#utils/ui.utils.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select.js';
import { menuItemLayoutClass } from '#components/ui/menu.variants.js';
import { groupItemsByTimeHorizon } from '#utils/temporal.utils.js';

type RepositorySelectorProperties = {
  readonly gitRef: ActorRefFrom<typeof gitMachine>;
  readonly onSelected: () => void;
  readonly onCancel?: () => void;
};

type GitRepositoryWithTimestamp = GitRepository & { updatedAt: number };

const reposPerPage = 30;

export function RepositorySelector({ gitRef, onSelected, onCancel }: RepositorySelectorProperties): React.ReactNode {
  const [repositories, setRepositories] = useState<GitRepositoryWithTimestamp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitRepository | undefined>();
  const [selectedScope, setSelectedScope] = useState<string | undefined>();
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const { hooks } = useContext(AuthUIContext);
  const { data: session } = hooks.useSession();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Ref to prevent duplicate requests from rapid scroll events.
  // React state updates are async, so we use a ref for synchronous guard checks.
  const isLoadingMoreRef = useRef(false);

  // Extract unique scopes (owners) from repositories
  const scopes = useMemo(() => {
    const uniqueOwners = new Set(repositories.map((repo) => repo.owner));
    return [...uniqueOwners].sort();
  }, [repositories]);

  // Filter repositories by selected scope
  const filteredRepositories = useMemo(() => {
    if (!selectedScope) {
      return repositories;
    }

    return repositories.filter((repo) => repo.owner === selectedScope);
  }, [repositories, selectedScope]);

  // Group repositories by time horizon
  const groupedRepositories = useMemo(() => {
    return groupItemsByTimeHorizon(filteredRepositories);
  }, [filteredRepositories]);

  const fetchRepositories = useCallback(async (page: number, isInitial: boolean): Promise<void> => {
    try {
      if (isInitial) {
        setIsLoading(true);
      } else {
        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);
      }

      const token = await getGitHubAccessToken();
      const response = await fetch(
        `https://api.github.com/user/repos?per_page=${reposPerPage}&page=${page}&sort=updated&direction=desc`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      if (!response.ok) {
        throw new Error('Failed to fetch repositories');
      }

      const data = (await response.json()) as Array<{
        owner: { login: string };
        name: string;
        clone_url: string;
        default_branch?: string;
        private: boolean;
        updated_at: string;
      }>;

      const repos: GitRepositoryWithTimestamp[] = data.map((repo) => ({
        owner: repo.owner.login,
        name: repo.name,
        url: repo.clone_url,
        branch: repo.default_branch ?? 'main',
        isPrivate: repo.private,
        updatedAt: new Date(repo.updated_at).getTime(),
      }));

      // Check if there are more pages
      setHasMore(repos.length === reposPerPage);

      if (isInitial) {
        setRepositories(repos);
        // Default to the first scope
        if (repos.length > 0) {
          const firstScope = repos[0]?.owner;
          if (firstScope) {
            setSelectedScope(firstScope);
          }
        }
      } else {
        setRepositories((previous) => [...previous, ...repos]);
      }
    } catch {
      toast.error('Failed to load repositories');
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      isLoadingMoreRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchRepositories(1, true);
  }, [fetchRepositories]);

  const handleLoadMore = useCallback(() => {
    // Use ref for synchronous guard to prevent duplicate requests from rapid scroll events
    if (!isLoadingMoreRef.current && hasMore) {
      isLoadingMoreRef.current = true;
      const nextPage = currentPage + 1;
      setCurrentPage(nextPage);
      void fetchRepositories(nextPage, false);
    }
  }, [currentPage, fetchRepositories, hasMore]);

  // Infinite scroll handler
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Load more when scrolled to 80% of the container
      // Use ref for synchronous guard to prevent duplicate requests from rapid scroll events
      if (scrollTop + clientHeight >= scrollHeight * 0.8 && hasMore && !isLoadingMoreRef.current) {
        handleLoadMore();
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleLoadMore, hasMore]);

  const handleSelectRepo = useCallback(
    async (repo: GitRepository) => {
      setSelectedRepo(repo);

      try {
        const token = await getGitHubAccessToken();

        // Send authenticate event
        gitRef.send({
          type: 'authenticate',
          accessToken: token,
          username: session?.user.name ?? 'user',
          email: session?.user.email ?? 'user@example.com',
        });

        // Send repository selection
        gitRef.send({
          type: 'selectRepository',
          repository: repo,
        });

        toast.success(`Connected to ${repo.owner}/${repo.name}`);
        onSelected();
      } catch {
        toast.error('Failed to connect repository');
      }
    },
    [onSelected, session, gitRef],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Loader className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading repositories...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Select Repository</h4>
        {onCancel ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {/* Git Scope Selector */}
      {scopes.length > 0 && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground">Git Scope</label>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select Git Scope" />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  <div className={menuItemLayoutClass}>
                    <User />
                    {scope}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex flex-col gap-4 overflow-y-auto">
        {groupedRepositories.map((group) => (
          <div key={group.name} className="flex flex-col gap-2">
            <h5 className="px-3 text-xs font-medium text-muted-foreground">{group.name}</h5>
            <div className="flex flex-col gap-2 px-3">
              {group.items.map((repo) => (
                <button
                  key={`${repo.owner}/${repo.name}`}
                  type="button"
                  className={cn(
                    'flex items-center justify-between rounded-md border p-3 text-left transition-colors hover:bg-muted',
                    selectedRepo?.name === repo.name && 'border-primary bg-muted',
                  )}
                  onClick={() => {
                    void handleSelectRepo(repo);
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">
                      {repo.owner}/{repo.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {repo.branch} • {repo.isPrivate ? 'Private' : 'Public'}
                    </span>
                  </div>
                  <GitBranch className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* Load More / Loading indicator */}
        {hasMore ? (
          <div className="flex justify-center py-2">
            {isLoadingMore ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader className="size-4" />
                <span>Loading more...</span>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={handleLoadMore}>
                <MoreHorizontal className="size-4" />
                <span>Load More</span>
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
