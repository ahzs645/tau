import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- mock return type
const mockUseProjects = vi.fn();
vi.mock('#hooks/use-projects.js', () => ({
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- mock
  useProjects: () => mockUseProjects(),
}));

vi.mock('react-router', () => ({
  NavLink: ({
    children,
    to,
  }: {
    children: React.ReactNode | ((props: Record<string, unknown>) => React.ReactNode);
    to: string;
  }) => {
    if (typeof children === 'function') {
      return <a href={to}>{children({ isActive: false, isPending: false })}</a>;
    }
    return <a href={to}>{children}</a>;
  },
  useNavigate: () => vi.fn(),
}));

vi.mock('#components/ui/sidebar.js', () => ({
  SidebarGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid='sidebar-group' className={className}>
      {children}
    </div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='sidebar-group-label'>{children}</div>
  ),
  SidebarMenu: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
    <ul {...props}>{children}</ul>
  ),
  SidebarMenuAction: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock('#components/ui/dropdown-menu.js', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/search-input.js', () => ({
  SearchInput: () => <input data-testid='search-input' />,
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: { success: vi.fn() },
}));

vi.mock('#utils/temporal.utils.js', () => ({
  groupItemsByTimeHorizon: (items: unknown[]) => (items.length > 0 ? [{ name: 'Today', items }] : []),
}));

const defaultProjectReturn = {
  projects: [],
  isLoading: false,
  error: undefined,
  deleteProject: vi.fn(),
  restoreProject: vi.fn(),
  duplicateProject: vi.fn(),
  updateName: vi.fn(),
};

describe('NavHistory', () => {
  beforeEach(() => {
    mockUseProjects.mockReturnValue(defaultProjectReturn);
  });

  it('should render a loading skeleton when projects are loading', async () => {
    mockUseProjects.mockReturnValue({ ...defaultProjectReturn, isLoading: true });

    const { NavHistory } = await import('#components/nav/nav-history.js');
    render(<NavHistory />);

    const labels = screen.getAllByTestId('sidebar-group-label');
    expect(labels.some((label) => label.textContent === 'Recent Projects')).toBe(true);

    expect(screen.getByTestId('nav-history-skeleton')).toBeDefined();
  });

  it('should render null only when genuinely empty and not loading', async () => {
    mockUseProjects.mockReturnValue({ ...defaultProjectReturn, projects: [], isLoading: false });

    const { NavHistory } = await import('#components/nav/nav-history.js');
    const { container } = render(<NavHistory />);

    expect(container.innerHTML).toBe('');
  });

  it('should render project list when projects are available', async () => {
    mockUseProjects.mockReturnValue({
      ...defaultProjectReturn,
      projects: [
        { id: 'p1', name: 'Test Project', description: 'A test', createdAt: new Date(), updatedAt: new Date() },
      ],
    });

    const { NavHistory } = await import('#components/nav/nav-history.js');
    render(<NavHistory />);

    expect(screen.getByText('Test Project')).toBeDefined();
  });
});
