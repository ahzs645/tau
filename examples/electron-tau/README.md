# Electron Tau Example

Desktop demo that embeds the Tau runtime (`@taucad/runtime` + `@taucad/openscad`) inside an
Electron shell.

## One-time setup

Electron's binary download is intentionally excluded from the workspace-wide install
(`onlyBuiltDependencies` in the root `package.json`): the ~100 MB fetch from GitHub hard-fails the
whole `pnpm install` in sandboxed or proxied environments, and only this example needs it. Fetch the
binary on demand instead:

```bash
pnpm rebuild electron
```

Then run the example's targets as usual (`nx run example-electron:dev`, `nx run example-electron:e2e`).
