import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { SWRConfig } from 'swr'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DataApiDataChangeEffect, DataRequest, DataResponse } from '@shared/data/api/types'

vi.unmock('@data/DataApiService')
vi.unmock('@data/hooks/useDataApi')

const executable = process.env.EVOSTACK_BACKEND_EXECUTABLE

describe.runIf(Boolean(executable))('native mutation delivery contract', () => {
  let child: ChildProcessWithoutNullStreams
  let profile: string
  let nextId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let mode: 'normal' | 'delay' | 'drop' = 'normal'
  let posts = 0
  let release: (() => void) | undefined
  const evidence: Array<{ scenario: string; posts: number; addedRows: number }> = []
  const changeListeners: Array<(effects: DataApiDataChangeEffect[]) => void> = []
  const reads = new Map<string, number>()
  const knowledgeReads: Array<{ request: DataRequest; response: DataResponse }> = []

  function rpc(method: string, params: unknown): Promise<any> {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async function data(request: DataRequest): Promise<DataResponse> {
    if (request.method === 'GET') reads.set(request.path, (reads.get(request.path) ?? 0) + 1)
    const response = await rpc('ipc.invoke', { channel: 'data-api:request', args: [request] })
    if (request.path.startsWith('/knowledge-bases/')) knowledgeReads.push({ request, response })
    if (request.method === 'POST' && request.path === '/topics') {
      posts++
      // The actual Go response follows SQLite COMMIT. Only delivery to React is interrupted.
      if (mode === 'delay')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (mode === 'drop') throw new Error('Synthetic response loss after the native commit')
    }
    return response
  }

  async function countTopics(): Promise<number> {
    const response = await rpc('ipc.invoke', {
      channel: 'data-api:request',
      args: [{ id: `read-${nextId}`, method: 'GET', path: '/topics' }]
    })
    expect(response.error).toBeUndefined()
    return response.data.items.length
  }

  async function start() {
    child = spawn(executable!, ['--data-dir', profile], { windowsHide: true, stdio: 'pipe' })
    child.stderr.resume()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const frame = JSON.parse(line)
      if (frame.method === 'event' && frame.params.channel === 'data-api:data-changed') {
        for (const listener of changeListeners) listener(frame.params.args[0])
      }
      if (typeof frame.id !== 'number') return
      const reply = pending.get(frame.id)
      if (!reply) return
      pending.delete(frame.id)
      if (frame.error) reply.reject(new Error(frame.error.message))
      else reply.resolve(frame.result)
    })
    child.once('exit', () => {
      for (const reply of pending.values()) reply.reject(new Error('Owned native test backend exited'))
      pending.clear()
    })
    await rpc('backend.info', null)
  }

  async function stop() {
    if (!child || child.exitCode !== null) return
    const exited = once(child, 'exit')
    await rpc('backend.shutdown', null)
    await exited
  }

  beforeAll(async () => {
    const directory = resolve('native/evostack/.cache/tmp')
    mkdirSync(directory, { recursive: true })
    profile = mkdtempSync(resolve(directory, 'mutation-delivery-'))
    await start()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        dataApi: {
          request: data,
          onDataChanged: (callback: (effects: DataApiDataChangeEffect[]) => void) => changeListeners.push(callback)
        }
      }
    })
  })

  afterAll(async () => {
    cleanup()
    release?.()
    await stop()
    if (profile) writeFileSync(resolve(profile, 'mutation-result.json'), JSON.stringify(evidence, null, 2))
    if (profile) writeFileSync(resolve(profile, 'knowledge-query-result.json'), JSON.stringify(knowledgeReads, null, 2))
  })

  it('does not create another row when a committed response arrives after the renderer deadline', async () => {
    const { DataApiService } = await import('../DataApiService')
    const service = new DataApiService()
    const before = await countTopics()
    posts = 0
    mode = 'delay'
    await expect(service.post('/topics', { body: { name: 'Committed once despite timeout' } })).rejects.toThrow(
      'outcome is unknown'
    )
    // The old implementation would send another POST after its one-second backoff.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    release?.()
    mode = 'normal'
    const addedRows = (await countTopics()) - before
    expect(posts).toBe(1)
    expect(addedRows).toBe(1)
    evidence.push({ scenario: 'delayed-after-commit', posts, addedRows })
  }, 12000)

  it('preserves one committed row across response loss and backend restart', async () => {
    const { DataApiService } = await import('../DataApiService')
    const service = new DataApiService()
    const before = await countTopics()
    posts = 0
    mode = 'drop'
    await expect(service.post('/topics', { body: { name: 'Committed once despite lost response' } })).rejects.toThrow(
      'outcome is unknown'
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    mode = 'normal'
    await stop()
    await start()
    const addedRows = (await countTopics()) - before
    expect(posts).toBe(1)
    expect(addedRows).toBe(1)
    evidence.push({ scenario: 'lost-after-commit-and-restart', posts, addedRows })
  }, 12000)

  it('updates a mounted scalar model from the real committed backend event without refetching another model', async () => {
    const { dataApiService: service } = await import('../DataApiService')
    await service.post('/providers', { body: { providerId: 'scalar-contract', name: 'Scalar contract' } })
    await service.post('/models', {
      body: [
        { providerId: 'scalar-contract', modelId: 'vendor/one', name: 'Before' },
        { providerId: 'scalar-contract', modelId: 'two', name: 'Unchanged' }
      ]
    })
    const { useModelById } = await import('@renderer/hooks/useModel')
    const first = 'scalar-contract::vendor/one'
    const second = 'scalar-contract::two'
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => new Map() } }, children)
    const { result } = renderHook(() => ({ first: useModelById(first), second: useModelById(second) }), { wrapper })
    await waitFor(() => expect(result.current.first.model?.name).toBe('Before'))
    await waitFor(() => expect(result.current.second.model?.name).toBe('Unchanged'))
    const otherReads = reads.get(`/models/${second}`)
    await act(async () => {
      await service.patch(`/models/${first}`, { body: { name: 'After', contextWindow: 8192 } })
    })
    await waitFor(() => expect(result.current.first.model?.name).toBe('After'))
    expect(result.current.first.model?.contextWindow).toBe(8192)
    expect(result.current.second.model?.name).toBe('Unchanged')
    expect(reads.get(`/models/${second}`)).toBe(otherReads)
    await act(async () => {
      await service.delete(`/models/${first}`)
    })
    await waitFor(() => expect(result.current.first.error).toBeDefined())
    expect(result.current.second.model?.name).toBe('Unchanged')
    cleanup()
  }, 12000)

  it('lists root knowledge items through the original paginated hook and query', async () => {
    const base = await rpc('ipc.invoke', {
      channel: 'ipc-api:request',
      args: ['knowledge.create_base', { base: { name: 'Original hook knowledge' } }]
    })
    expect(base.ok).toBe(true)
    const added = await rpc('ipc.invoke', {
      channel: 'ipc-api:request',
      args: [
        'knowledge.add_items',
        {
          baseId: base.data.id,
          items: [{ type: 'note', data: { source: 'Hook note', content: 'Original hook query fixture' } }]
        }
      ]
    })
    expect(added.ok).toBe(true)
    const other = await rpc('ipc.invoke', {
      channel: 'ipc-api:request',
      args: ['knowledge.create_base', { base: { name: 'Other hook knowledge' } }]
    })
    expect(other.ok).toBe(true)
    const { useKnowledgeItems } = await import('@renderer/hooks/useKnowledgeItems')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => new Map() } }, children)
    const { result } = renderHook(
      () => ({ first: useKnowledgeItems(base.data.id), other: useKnowledgeItems(other.data.id) }),
      { wrapper }
    )
    await waitFor(() => {
      expect(result.current.first.error).toBeUndefined()
      expect(result.current.first.items).toHaveLength(1)
      expect(result.current.other.isLoading).toBe(false)
    })
    expect(result.current.first.total).toBe(1)
    expect(result.current.first.items[0].data.source).toBe('Hook note')
    const otherReads = reads.get(`/knowledge-bases/${other.data.id}/items`)
    await act(async () => {
      const result = await rpc('ipc.invoke', {
        channel: 'ipc-api:request',
        args: [
          'knowledge.add_items',
          {
            baseId: base.data.id,
            items: [
              {
                type: 'note',
                data: { source: 'Second hook note', content: 'New item must appear without a manual refresh' }
              }
            ]
          }
        ]
      })
      expect(result.ok).toBe(true)
    })
    await waitFor(() => expect(result.current.first.items).toHaveLength(2))
    expect(result.current.first.total).toBe(2)
    expect(reads.get(`/knowledge-bases/${other.data.id}/items`)).toBe(otherReads)
    cleanup()
  }, 12000)
})
