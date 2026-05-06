/**
 * A prefix for an ID.
 *
 * Prefixes are used to quickly identify the type of ID.
 *
 * They are ideally 3 characters long, but can be longer or shorter when needed to:
 * - Preserve acronyms
 * - Distinguish between similar IDs
 */
export const idPrefix = {
  /**
   * An LLM chat message ID.
   */
  message: 'msg',
  /**
   * An LLM chat ID.
   */
  chat: 'chat',
  /**
   * A CAD project identifier (IndexedDB + `/projects/:id` routing).
   */
  project: 'proj',
  /**
   * A publication record identifier (`publication.id`).
   */
  publication: 'pub',
  /**
   * Non-secret token for unlisted publication URLs (`publication.unlisted_token`).
   */
  publicationToken: 'put',
  /**
   * Opaque visitor id embedded in the signed `tau_view_id` publication-view cookie.
   */
  publicationViewer: 'pvv',
  /**
   * Opaque blob record identifiers stored locally when keyed independently from SHA (`blob_ref` is keyed by SHA — placeholder prefix).
   */
  blobRef: 'blob',
  /**
   * An LLM chat tool call ID.
   */
  toolCall: 'tool',
  /**
   * An LLM chat source ID.
   */
  source: 'src',
  /**
   * An LLM chat run ID.
   */
  run: 'run',
  /**
   * A request ID.
   */
  request: 'req',
  /**
   * A runtime transport command ID. Correlates `RuntimeCommand` requests with
   * their matching `RuntimeResponse` so multiple in-flight commands on a
   * single channel can settle independently.
   */
  command: 'cmd',
  /**
   * An account ID.
   */
  account: 'acct',
  /**
   * An organization ID.
   */
  organization: 'org',
  /**
   * A user ID.
   */
  user: 'user',
  /**
   * A session ID.
   */
  session: 'sess',
  /**
   * A verification ID.
   */
  verification: 'ver',
  /**
   * A rate limit ID.
   */
  rateLimit: 'rl',
  /**
   * A member ID.
   */
  member: 'mem',
  /**
   * An organization invitation ID.
   */
  invitation: 'invt',
  /**
   * A two factor ID.
   */
  twoFactor: 'totp',
  /**
   * A JWKS ID.
   */
  jwks: 'jwks',
  /**
   * A passkey ID.
   */
  passkey: 'pk',
  /**
   * A secret key ID (for API keys).
   */
  secretKey: 'sk',
  /**
   * A public key ID (for API keys).
   */
  publicKey: 'pk',
  /**
   * A log ID.
   */
  log: 'log',
  /**
   * A measurement ID.
   */
  measurement: 'meas',
  /**
   * An observation ID.
   */
  observation: 'obs',
  /**
   * A data part ID.
   */
  data: 'data',
  /**
   * A view ID
   */
  view: 'view',
  /**
   * A browser tab ID.
   */
  tab: 'tab',
} as const satisfies Record<string, string>;
