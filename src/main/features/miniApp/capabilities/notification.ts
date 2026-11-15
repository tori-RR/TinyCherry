import * as z from 'zod'

import { RateLimitedError } from './quota'

const ShowParams = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(500).optional()
})

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5
const windows = new Map<string, { start: number; used: number }>()

/** Test seam only. */
export function resetNotificationRateForTest(): void {
  windows.clear()
}

export const notificationCapability = {
  async show(appId: string, params: unknown) {
    // Non-strict on purpose: a forged `sourceAppId` is dropped rather than rejected,
    // and attribution comes from the authenticated caller below.
    ShowParams.parse(params)

    const now = Date.now()
    const win = windows.get(appId)
    if (!win || now - win.start >= WINDOW_MS) {
      windows.set(appId, { start: now, used: 1 })
    } else if (win.used >= MAX_PER_WINDOW) {
      throw new RateLimitedError(`notification rate exceeded: more than ${MAX_PER_WINDOW} per minute`)
    } else {
      win.used += 1
    }

    // Keep the mini-app bridge contract when desktop notifications are disabled.
    return { ok: true }
  }
}
