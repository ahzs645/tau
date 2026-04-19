/** @public */
export const messageRole = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
} as const;

/** @public */
export const messageRoles = Object.values(messageRole);

/** @public */
export const messageStatus = {
  pending: 'pending',
  success: 'success',
  error: 'error',
  cancelled: 'cancelled',
} as const;

/** @public */
export const messageStatuses = Object.values(messageStatus);
