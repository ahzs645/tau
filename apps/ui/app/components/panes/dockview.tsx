import type { ComponentProps } from 'react';
import type { DockviewTheme } from 'dockview-react';
import { DockviewReact } from 'dockview-react';
import { DockviewSplitAction } from '#components/panes/dockview-split-action.js';

/**
 * Custom Dockview theme that maps CSS variables to the application's design tokens.
 * The CSS overrides for `.dockview-theme-tau` are defined in `./tau-dockview.css`.
 */
const tauDockviewTheme: DockviewTheme = {
  name: 'tau',
  className: 'dockview-theme-tau',
};

type DockviewProperties = Omit<ComponentProps<typeof DockviewReact>, 'theme'>;

/**
 * Themed Dockview wrapper.
 *
 * Renders `DockviewReact` with the `tauDockviewTheme` applied automatically.
 * Includes a "split right" button in the right side of each group's tab bar
 * (visible on hover). All theme CSS lives in the co-located `tau-dockview.css`
 * stylesheet which is loaded via `global.styles.ts` after the base dockview CSS.
 *
 * Dockview v4.13+ defaults to `'onlyWhenVisible'` rendering, which appends
 * panel content directly into `.dv-content-container` (a child of
 * `.dv-groupview`).  This keeps the content inside the groupview DOM tree,
 * allowing plain CSS `.dv-groupview:hover` to fire for both the tab bar and
 * the content area of every split pane.
 */
export function Dockview(properties: DockviewProperties): React.JSX.Element {
  return (
    <DockviewReact
      {...properties}
      theme={tauDockviewTheme}
      rightHeaderActionsComponent={properties.rightHeaderActionsComponent ?? DockviewSplitAction}
    />
  );
}
