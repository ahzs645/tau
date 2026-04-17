import { createContext, useContext } from 'react';

type ActivityFoldContextValue = {
  /**
   * When true, descendant aggregated groups skip their own collapsible chrome
   * and render children inline — the ancestor fold (e.g. `ChatActivitySection`)
   * is the canonical outer fold and already carries the summary.
   */
  readonly disableInnerFold: boolean;
};

export const ActivityFoldContext = createContext<ActivityFoldContextValue>({
  disableInnerFold: false,
});

export const useActivityFoldContext = (): ActivityFoldContextValue => useContext(ActivityFoldContext);
