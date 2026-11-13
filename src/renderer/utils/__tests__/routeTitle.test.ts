import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock i18n before importing the module
vi.mock('@renderer/i18n/resolver', () => ({
  default: {
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'common.chat': '聊天',
        'agent.session.group.conversation': '对话',
        'agent.sidebar_title': '任务',
        'title.work': '工作',
        'title.paintings': '绘画',
        'title.marketplace': '广场',
        'settings.scheduledTasks.title': '定时任务',
        'title.translate': '翻译',
        'title.apps': '小程序',
        'title.knowledge': '知识库',
        'title.files': '文件',
        'title.code': 'Code',
        'title.notes': '笔记',
        'settings.about.releases.title': '更新日志',
        'title.settings': '设置'
      }
      return translations[key] || key
    })
  }
}))

import { getDefaultRouteTitle, getRouteTitleKey, isTopLevelRoute } from '../routeTitle'

describe('routeTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDefaultRouteTitle', () => {
    describe('exact route matches', () => {
      it.each([
        ['/app/chat', '对话'],
        ['/app/agents', '工作'],
        ['/app/paintings', '绘画'],
        ['/app/marketplace', '广场'],
        ['/app/scheduled-tasks', '定时任务'],
        ['/app/mini-app', '小程序'],
        ['/app/files', '文件'],
        ['/app/code', 'Code'],
        ['/app/notes', '笔记'],
        ['/app/release-notes', '更新日志'],
        ['/settings', '设置']
      ])('should return correct title for %s', (url, expectedTitle) => {
        expect(getDefaultRouteTitle(url)).toBe(expectedTitle)
      })
    })

    describe('nested route matches', () => {
      it('should match base path for nested routes', () => {
        expect(getDefaultRouteTitle('/app/chat/topic-123')).toBe('对话')
        expect(getDefaultRouteTitle('/app/agents/session-123')).toBe('工作')
        expect(getDefaultRouteTitle('/settings/provider')).toBe('设置')
        expect(getDefaultRouteTitle('/settings/mcp/servers')).toBe('设置')
        expect(getDefaultRouteTitle('/app/paintings/zhipu')).toBe('绘画')
      })
    })

    describe('URL with query params and hash', () => {
      it('should handle URLs with query parameters', () => {
        expect(getDefaultRouteTitle('/app/chat?topicId=123')).toBe('对话')
        expect(getDefaultRouteTitle('/settings/provider?id=openai')).toBe('设置')
      })

      it('should handle URLs with hash', () => {
        expect(getDefaultRouteTitle('/app/files#section1')).toBe('文件')
      })

      it('should handle URLs with both query and hash', () => {
        expect(getDefaultRouteTitle('/app/chat?id=1#message-5')).toBe('对话')
      })
    })

    describe('unknown routes', () => {
      it('should return last segment for unknown routes', () => {
        expect(getDefaultRouteTitle('/unknown')).toBe('unknown')
        expect(getDefaultRouteTitle('/app/openclaw')).toBe('openclaw')
        expect(getDefaultRouteTitle('/foo/bar/baz')).toBe('baz')
      })

      it('should return pathname for root-like unknown routes', () => {
        expect(getDefaultRouteTitle('/x')).toBe('x')
      })
    })

    describe('edge cases', () => {
      it('should reject double slashes (protocol-relative URL)', () => {
        // '//chat' is a protocol-relative URL, so 'chat' parses as the host,
        // not an app-route path. parseAppRouteUrl rejects it and the title
        // falls back to the empty string.
        expect(getDefaultRouteTitle('//chat')).toBe('')
      })
    })
  })

  describe('getRouteTitleKey', () => {
    describe('unknown routes', () => {
      it('should return undefined for unknown routes', () => {
        expect(getRouteTitleKey('/unknown')).toBeUndefined()
        expect(getRouteTitleKey('/app/openclaw')).toBeUndefined()
        expect(getRouteTitleKey('/foo/bar')).toBeUndefined()
      })
    })
  })

  describe('isTopLevelRoute', () => {
    it('returns true only for bare top-level route tabs', () => {
      expect(isTopLevelRoute('/app/chat')).toBe(true)
      expect(isTopLevelRoute('/app/agents')).toBe(true)
      expect(isTopLevelRoute('/app/release-notes')).toBe(true)
      expect(isTopLevelRoute('/app/chat?topicId=123')).toBe(false)
      expect(isTopLevelRoute('/app/agents#session')).toBe(false)
      expect(isTopLevelRoute('/app/chat/topic-123')).toBe(false)
    })
  })
})
