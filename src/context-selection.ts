/** Prefer the user's session; public pages may fall back if it is known dead. */
export function useAuthenticatedContext(userId: string | undefined, hasSession: boolean, allowAnonymous: boolean, sessionDead = false): boolean {
  return !!userId && hasSession && !(allowAnonymous && sessionDead);
}
