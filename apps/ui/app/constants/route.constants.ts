import {
  BookOpen,
  Bot,
  ChartColumn,
  FileAxis3D,
  Files,
  Frame,
  Hammer,
  Import,
  Map,
  PieChart,
  Settings,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { openSettingsDialog } from '#hooks/use-settings-dialog.js';

type NavRoute = {
  title: string;
  url: string;
  icon: LucideIcon;
  /** When set, clicking the item calls this instead of navigating to `url`. */
  action?: () => void;
};

type NavProject = {
  name: string;
  url: string;
  icon: LucideIcon;
};

export const navRoutes: {
  navMain: NavRoute[];
  navSecondary: NavRoute[];
  projects: NavProject[];
} = {
  navMain: [
    {
      title: 'Builds',
      url: '/builds/library',
      icon: Hammer,
      // Items: [
      //   {
      //     title: 'History',
      //     url: '/builds/history',
      //   },
      //   {
      //     title: 'Starred',
      //     url: '/builds/starred',
      //   },
      //   {
      //     title: 'Settings',
      //     url: '/builds/settings',
      //   },
      // ],
    },
    {
      title: 'Community',
      url: '/builds/community',
      icon: UsersRound,
    },
    {
      title: 'Converter',
      url: '/converter',
      icon: FileAxis3D,
    },
    {
      title: 'Importer',
      url: '/import',
      icon: Import,
    },
    // {
    //   title: 'Workflows',
    //   url: '/workflows',
    //   icon: Workflow,
    // },
    {
      title: 'Models',
      url: '/models',
      icon: Bot,
    },
    {
      title: 'Usage',
      url: '/usage',
      icon: ChartColumn,
    },
  ],
  navSecondary: [
    {
      title: 'Files',
      url: '/files',
      icon: Files,
    },
    {
      title: 'Documentation',
      url: '/docs',
      icon: BookOpen,
    },
    {
      title: 'Settings',
      url: '/settings',
      icon: Settings,
      action(): void {
        openSettingsDialog();
      },
    },
  ],
  projects: [
    {
      name: 'Design Engineering',
      url: '/projects/design-engineering',
      icon: Frame,
    },
    {
      name: 'Sales & Marketing',
      url: '/projects/sales-marketing',
      icon: PieChart,
    },
    {
      name: 'Travel',
      url: '/projects/travel',
      icon: Map,
    },
  ],
};
