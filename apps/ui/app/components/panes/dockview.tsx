import type { ComponentProps } from 'react';
import type { DockviewTheme } from 'dockview-react';
import { DockviewReact } from 'dockview-react';

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
 * All theme CSS lives in the co-located `tau-dockview.css` stylesheet which is
 * loaded via `global.styles.ts` after the base dockview CSS.
 */
export function Dockview(properties: DockviewProperties): React.JSX.Element {
  return <DockviewReact {...properties} theme={tauDockviewTheme} />;
}
