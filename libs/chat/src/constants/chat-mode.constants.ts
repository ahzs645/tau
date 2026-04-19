/** @public */
export const chatMode = {
  agent: 'agent',
  plan: 'plan',
} as const;

/** @public */
export type ChatMode = (typeof chatMode)[keyof typeof chatMode];

/** @public */
export const chatModes = Object.values(chatMode);
