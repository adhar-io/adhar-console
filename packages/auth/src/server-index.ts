/**
 * Server-only entrypoint for `@adhar/auth/server`.
 *
 * Everything here runs exclusively in the BFF / TanStack Start server routes.
 * It pulls in `jose` and the confidential client secret, so it MUST NOT be
 * imported from any browser-reachable module. The browser uses
 * `@adhar/auth` (client-safe) instead.
 */
export {
  getServerAuthConfig,
  isServerAuthConfigured,
  resolvePublicOrigin,
  type ServerAuthConfig,
} from './config.ts'
export { getDiscovery, getJwks, type OidcEndpoints } from './discovery.ts'
export {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkce,
  exchangeCode,
  randomNonce,
  refreshTokens,
  sessionFromTokens,
  verifyAccessToken,
  verifyIdToken,
  claimsToUser,
  type TokenResponse,
} from './server.ts'
export {
  destroySession,
  setSessionStore,
  signSessionToken,
  toClientSession,
  verifySessionToken,
  type ServerSession,
  type ServerSessionStore,
} from './session-store.ts'
export {
  clearCookie,
  parseCookies,
  serializeCookie,
  sign,
  unsign,
  type CookieAttributes,
} from './cookies.ts'
export {
  getValidSession,
  handleCallback,
  handleLogin,
  handleLogout,
  handleSession,
  readSession,
  refreshSessionNow,
} from './handlers.ts'
// The console permission catalogue is pure data shared with the browser; it is
// re-exported here so BFF code takes it from the server entrypoint and never
// pulls the client bundle (React contexts) into the server graph.
export {
  accessCheckKey,
  CONSOLE_API_GROUP,
  CONSOLE_PERMISSIONS,
  consoleCheck,
  consoleResourceCatalogue,
  ORG_SCOPED_PERMISSIONS,
  type AccessCheck,
  type ConsolePermission,
  type ConsolePermissionName,
  type OrgScopedRole,
} from './console-permissions.ts'
