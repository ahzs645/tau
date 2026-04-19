/**
 * WebSocket close codes for chat tools connection.
 * @public
 */
export const wsCloseCode = {
  /** Connection rejected due to authentication failure */
  unauthenticated: 4001,
  /** Connection superseded by a new connection for the same chatId */
  superseded: 4002,
  /** Chat session ended normally */
  sessionEnded: 4003,
} as const;
