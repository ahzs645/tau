/* Fixture for ESLint integration test — must fail `no-restricted-imports`. */
/* oxlint-disable @typescript-eslint/no-unused-vars -- fixture only */
/* eslint-disable @typescript-eslint/no-unused-vars -- fixture only */

import { getTestFileSystem } from '@taucad/runtime/testing';

export const leaked = (): unknown => getTestFileSystem();
