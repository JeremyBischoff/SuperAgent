/**
 * SUP-227 — Auth-mode notifications must scope by `notifications.user_id`, not
 * just by accessible-agent ACL.
 *
 * In AUTH_MODE the notification service scoped list/count/mark-read queries by
 * the caller's accessible agent slugs only and never by the per-user owner
 * column (`notifications.user_id`). Two users who share an agent therefore saw
 * each other's notification bodies/history and cleared each other's unread/read
 * state through a single shared `isRead` bit. The `:id/read` + `DELETE :id`
 * endpoints were likewise agent-scoped, so a teammate could flip/delete a
 * notification they do not own.
 *
 * These tests seed per-user notification rows directly (notif-a → userA,
 * notif-b → userB) on the same shared agent + session and assert that auth-mode
 * scoping is by user. They FAIL on the pre-fix code (agent-ACL-only scoping) and
 * PASS once each auth-mode query / the middleware also matches user_id. Non-auth
 * behavior (userId undefined) must stay unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
let authModeEnabled = true

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

// isAuthMode is consulted by the route middleware (HasNotificationAccess) and by
// the ownership helpers. The service functions branch on the userId argument, so
// they are independent of this toggle.
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => authModeEnabled,
}))

import {
  listNotifications,
  getUnreadCount,
  markSessionNotificationsRead,
  markAsRead,
  getUnreadNotificationsByAgents,
  getSessionIdsWithUnreadNotifications,
} from './notification-service'
import { notifications, agentAcl } from '../db/schema'
import { HasNotificationAccess } from '../../../api/middleware/auth'

const USER_A = 'user-a'
const USER_B = 'user-b'
const AGENT = 'shared-agent'
const SESSION = 'shared-session'

async function seedAcl() {
  await testDb.insert(agentAcl).values([
    { id: 'acl-a', userId: USER_A, agentSlug: AGENT, role: 'owner', createdAt: new Date() },
    { id: 'acl-b', userId: USER_B, agentSlug: AGENT, role: 'user', createdAt: new Date() },
  ])
}

describe('SUP-227: auth-mode notifications scope by user_id', () => {
  beforeEach(() => {
    authModeEnabled = true
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  describe('same session, two owners', () => {
    beforeEach(async () => {
      await seedAcl()
      // Two per-user notifications on the SAME agent + session (the row-per-user
      // shape the fix relies on; createNotification can populate user_id post-fix,
      // but here we seed directly so the test is independent of the writer).
      await testDb.insert(notifications).values([
        {
          id: 'notif-a',
          type: 'session_waiting',
          sessionId: SESSION,
          agentSlug: AGENT,
          title: 'For A',
          body: 'secret addressed to A',
          isRead: false,
          userId: USER_A,
          createdAt: new Date(1_000),
        },
        {
          id: 'notif-b',
          type: 'session_waiting',
          sessionId: SESSION,
          agentSlug: AGENT,
          title: 'For B',
          body: 'secret addressed to B',
          isRead: false,
          userId: USER_B,
          createdAt: new Date(2_000),
        },
      ])
    })

    it('listNotifications returns only the calling user rows', async () => {
      expect((await listNotifications(50, USER_B)).map((n) => n.id)).toEqual(['notif-b'])
      expect((await listNotifications(50, USER_A)).map((n) => n.id)).toEqual(['notif-a'])
    })

    it('getUnreadCount counts only the calling user rows', async () => {
      expect(await getUnreadCount(USER_B)).toBe(1)
      expect(await getUnreadCount(USER_A)).toBe(1)
    })

    it('markSessionNotificationsRead marks only the calling user rows (no shared isRead bit)', async () => {
      const marked = await markSessionNotificationsRead(SESSION, USER_B)
      expect(marked).toBe(1)
      // userB cleared their own; userA's row is untouched.
      expect(await getUnreadCount(USER_B)).toBe(0)
      expect(await getUnreadCount(USER_A)).toBe(1)

      const aRow = await testDb.select().from(notifications).where(eq(notifications.id, 'notif-a'))
      expect(aRow[0]?.isRead).toBe(false)
      const bRow = await testDb.select().from(notifications).where(eq(notifications.id, 'notif-b'))
      expect(bRow[0]?.isRead).toBe(true)
    })

    it('non-auth mode (userId undefined) is unchanged — sees every row', async () => {
      expect((await listNotifications(50)).map((n) => n.id).sort()).toEqual(['notif-a', 'notif-b'])
      expect(await getUnreadCount()).toBe(2)
    })
  })

  describe('per-user unread session indicators (different sessions)', () => {
    beforeEach(async () => {
      await seedAcl()
      await testDb.insert(notifications).values([
        {
          id: 'notif-a',
          type: 'session_waiting',
          sessionId: 'session-a',
          agentSlug: AGENT,
          title: 'For A',
          body: 'b',
          isRead: false,
          userId: USER_A,
          createdAt: new Date(1_000),
        },
        {
          id: 'notif-b',
          type: 'session_waiting',
          sessionId: 'session-b',
          agentSlug: AGENT,
          title: 'For B',
          body: 'b',
          isRead: false,
          userId: USER_B,
          createdAt: new Date(2_000),
        },
      ])
    })

    it('getUnreadNotificationsByAgents groups only the calling user sessions', async () => {
      const mapB = await getUnreadNotificationsByAgents([AGENT], USER_B)
      expect([...(mapB.get(AGENT) ?? new Set())]).toEqual(['session-b'])

      const mapA = await getUnreadNotificationsByAgents([AGENT], USER_A)
      expect([...(mapA.get(AGENT) ?? new Set())]).toEqual(['session-a'])
    })

    it('getSessionIdsWithUnreadNotifications returns only the calling user sessions', async () => {
      const setB = await getSessionIdsWithUnreadNotifications(AGENT, USER_B)
      expect([...setB]).toEqual(['session-b'])

      const setA = await getSessionIdsWithUnreadNotifications(AGENT, USER_A)
      expect([...setA]).toEqual(['session-a'])
    })

    it('non-auth mode (userId undefined) still aggregates across all owners', async () => {
      const map = await getUnreadNotificationsByAgents([AGENT])
      expect([...(map.get(AGENT) ?? new Set())].sort()).toEqual(['session-a', 'session-b'])
    })
  })

  describe('HasNotificationAccess ownership gate (route middleware)', () => {
    beforeEach(async () => {
      await seedAcl()
      await testDb.insert(notifications).values([
        {
          id: 'notif-a',
          type: 'session_waiting',
          sessionId: SESSION,
          agentSlug: AGENT,
          title: 'For A',
          body: 'secret addressed to A',
          isRead: false,
          userId: USER_A,
          createdAt: new Date(1_000),
        },
        {
          id: 'notif-b',
          type: 'session_waiting',
          sessionId: SESSION,
          agentSlug: AGENT,
          title: 'For B',
          body: 'secret addressed to B',
          isRead: false,
          userId: USER_B,
          createdAt: new Date(2_000),
        },
      ])
    })

    function appAs(userId: string) {
      const app = new Hono()
      app.use('*', async (c, next) => {
        c.set('user' as never, { id: userId } as never)
        return next()
      })
      app.post('/api/notifications/:id/read', HasNotificationAccess(), async (c) => {
        const ok = await markAsRead(c.req.param('id'))
        return c.json({ success: ok })
      })
      return app
    }

    it("rejects userB marking userA's notification and does not flip it", async () => {
      const res = await appAs(USER_B).request('http://localhost/api/notifications/notif-a/read', {
        method: 'POST',
      })
      expect([403, 404]).toContain(res.status)

      const aRow = await testDb.select().from(notifications).where(eq(notifications.id, 'notif-a'))
      expect(aRow[0]?.isRead).toBe(false)
    })

    it('allows userB to mark their own notification', async () => {
      const res = await appAs(USER_B).request('http://localhost/api/notifications/notif-b/read', {
        method: 'POST',
      })
      expect(res.status).toBe(200)

      const bRow = await testDb.select().from(notifications).where(eq(notifications.id, 'notif-b'))
      expect(bRow[0]?.isRead).toBe(true)
    })

    it('non-auth mode passes through (no ownership concept)', async () => {
      authModeEnabled = false
      const res = await appAs('ignored').request('http://localhost/api/notifications/notif-a/read', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const aRow = await testDb.select().from(notifications).where(eq(notifications.id, 'notif-a'))
      expect(aRow[0]?.isRead).toBe(true)
    })
  })
})
