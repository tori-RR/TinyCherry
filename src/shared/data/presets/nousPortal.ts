/** Nous Portal uses device-code OAuth; credentials and refresh stay in the native backend. */
export const NOUS_PORTAL_PROVIDER_ID = 'nous-portal' as const

export function isNousPortalProviderId(providerId: string): boolean {
  return providerId === NOUS_PORTAL_PROVIDER_ID
}
