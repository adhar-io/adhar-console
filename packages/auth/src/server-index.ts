/**
 * Server-only entrypoint for `@adhar-console/auth/server`.
 *
 * Everything here runs exclusively in the BFF / TanStack Start server routes.
 * It pulls in `jose` and the confidential client secret, so it MUST NOT be
 * imported from any browser-reachable module. The browser uses
 * `@adhar-console/auth` (client-safe) instead.
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
  signSessionToken,
  toClientSession,
  verifySessionToken,
  type ServerSession,
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
} from './handlers.ts'
