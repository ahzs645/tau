// oxlint-disable-next-line import-x/no-unassigned-import -- side-effect import for jest-dom matchers
import '@testing-library/jest-dom';

// Neither jsdom nor happy-dom implements ResizeObserver, which radix-ui's use-size
// hook requires; the component tests only need it to exist, not to fire.
globalThis.ResizeObserver = class ResizeObserver {
  public observe() {
    // No-op
  }

  public unobserve() {
    // No-op
  }

  public disconnect() {
    // No-op
  }
};
