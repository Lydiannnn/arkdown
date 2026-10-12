import { describe, expect, it, vi } from 'vitest'
import {
  createModelCatalogClient,
  type ModelCatalogRequest,
} from '../../src/main/models/model-catalog-client'
import { ModelProtocolError } from '../../src/main/models/model-errors'

const baseRequest: ModelCatalogRequest = {
  provider: 'deepseek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-private',
  signal: new AbortController().signal,
}

describe('model catalog client', () => {
  it('reads, normalizes, deduplicates, and recommends an OpenAI-compatible model list', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        { id: ' deepseek-v4-flash ', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createModelCatalogClient(fetchImpl as typeof fetch)

    await expect(client.listModels(baseRequest)).resolves.toEqual({
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      recommendedModelId: 'deepseek-v4-flash',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://api.deepseek.com/models'),
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-private',
        }),
      }),
    )
  })

  it('uses and parses the provider-specific Qwen catalog endpoint', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      request_id: 'request',
      output: {
        models: [
          { model_name: 'qwen3.8-flash' },
          { model_name: 'qwen3.8-max' },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createModelCatalogClient(fetchImpl as typeof fetch)

    await expect(client.listModels({
      ...baseRequest,
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })).resolves.toEqual({
      models: ['qwen3.8-max', 'qwen3.8-flash'],
      recommendedModelId: 'qwen3.8-max',
    })
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as URL
    expect(calledUrl.origin + calledUrl.pathname)
      .toBe('https://dashscope.aliyuncs.com/api/v1/deployments/models')
    expect(calledUrl.searchParams.get('page_size')).toBe('100')
    expect(calledUrl.searchParams.get('version')).toBe('v1.0')
  })

  it('maps authentication failures without exposing provider response bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'secret account detail' },
    }), { status: 401 }))
    const client = createModelCatalogClient(fetchImpl as typeof fetch)

    const error = await client.listModels(baseRequest).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ModelProtocolError)
    expect((error as ModelProtocolError).status).toBe('authentication-failed')
    expect(String(error)).not.toContain('secret account detail')
  })

  it('rejects malformed and oversized model catalogs', async () => {
    const malformedClient = createModelCatalogClient(
      vi.fn(async () => new Response(JSON.stringify({
        object: 'list',
        data: [{ id: '' }, { id: 42 }],
      }), { status: 200 })) as typeof fetch,
    )
    await expect(malformedClient.listModels(baseRequest))
      .rejects.toMatchObject({ status: 'incompatible-response' })

    const oversizedClient = createModelCatalogClient(
      vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        status: 200,
      })) as typeof fetch,
    )
    await expect(oversizedClient.listModels(baseRequest))
      .rejects.toMatchObject({ status: 'incompatible-response' })
  })
})
