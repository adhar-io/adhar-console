/**
 * Client-safe entrypoint for `@adhar-console/auth`.
 *
 * Safe to import from the browser bundle — contains only types, the React
 * auth context/hooks, the pure claims→user mapping, and the dev stub session.
 * Server-only OIDC/JWKS/cookie code lives in `@adhar-console/auth/server`.
 */
export type { Session, User, Claims, Role } from './types.ts'
export { SessionSchema, UserSchema, ClaimsSchema } from './types.ts'
export { STUB_SESSION, STUB_USER, getStubSession } from './stub.ts'
export { claimsToUser } from './claims.ts'
export {
  AuthProvider,
  SessionContext,
  useAuth,
  useHasRole,
  useOptionalSession,
  useSession,
  useUser,
  type AuthContextValue,
  type AuthProviderProps,
  type AuthStatus,
} from './client.ts'
