import type { KernelProvider } from '@taucad/runtime';
import { kernelConfigurations } from '@taucad/types/constants';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

const defaultKernel: KernelProvider = 'openscad';

const kernelById = new Map(kernelConfigurations.map((k) => [k.id, k]));

// oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- intentionally allowing inference
export const useKernel = () => {
  const [kernel, setKernel] = useCookie<KernelProvider>(cookieName.cadKernel, defaultKernel);

  const selectedKernel = kernelById.get(kernel);

  return { kernel, setKernel, selectedKernel };
};
