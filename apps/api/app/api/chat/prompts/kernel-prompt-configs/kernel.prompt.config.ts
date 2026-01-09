import { replicadTypesCleanJsDoc } from '@taucad/api-extractor';
import type { KernelProvider } from '@taucad/types';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import { createOpenscadConfig } from '#api/chat/prompts/kernel-prompt-configs/openscad.prompt.config.js';
import { createReplicadConfig } from '#api/chat/prompts/kernel-prompt-configs/replicad.prompt.config.js';
import { createZooConfig } from '#api/chat/prompts/kernel-prompt-configs/zoo.prompt.config.js';
import { createJscadConfig } from '#api/chat/prompts/kernel-prompt-configs/jscad.prompt.config.js';
// Canonical examples imported as raw strings
import openscadExample from '#api/chat/prompts/kernel-prompt-configs/openscad.prompt.example.scad?raw';
import replicadExample from '#api/chat/prompts/kernel-prompt-configs/replicad.prompt.example.js?raw';
import zooExample from '#api/chat/prompts/kernel-prompt-configs/zoo.prompt.example.kcl?raw';
import jscadExample from '#api/chat/prompts/kernel-prompt-configs/jscad.prompt.example.js?raw';

// Build kernel config registry
const kernelConfigs: Record<KernelProvider, KernelConfig> = {
  openscad: createOpenscadConfig(openscadExample),
  replicad: createReplicadConfig(replicadTypesCleanJsDoc, replicadExample),
  zoo: createZooConfig(zooExample),
  jscad: createJscadConfig(jscadExample),
};

/**
 * Get the configuration for a specific CAD kernel.
 *
 * @param kernel - The kernel provider identifier
 * @returns The kernel configuration for the specified provider
 */
export function getKernelConfig(kernel: KernelProvider): KernelConfig {
  return kernelConfigs[kernel];
}
