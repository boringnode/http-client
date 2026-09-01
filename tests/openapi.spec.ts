import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from '@japa/runner'
import { defineHttpClient } from '../src/openapi.js'
import { HttpClientManager } from '../src/http_client_manager.js'
import type { HttpClient } from '../src/http_client.js'

interface Repository {
  id: number
  name: string
  private: boolean
}

interface NotFound {
  message: string
}

interface Issue {
  id: number
  title: string
}

interface GitHubApi {
  '/repos/{owner}/{repo}': {
    parameters: {
      query?: never
      header?: never
      path: { owner: string; repo: string }
      cookie?: never
    }
    get: {
      parameters: {
        query?: { page?: number }
        header?: never
        path?: never
        cookie?: never
      }
      requestBody?: never
      responses: {
        200: {
          headers: Record<string, unknown>
          content: { 'application/json': Repository }
        }
        404: {
          headers: Record<string, unknown>
          content: { 'application/json': NotFound }
        }
      }
    }
    post?: never
    put?: never
    patch?: never
    delete?: never
  }
  '/repos/{owner}/{repo}/issues': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    post: {
      parameters: {
        query?: never
        header?: never
        path: { owner: string; repo: string }
        cookie?: never
      }
      requestBody: {
        content: { 'application/json': { title: string } }
      }
      responses: {
        201: {
          headers: Record<string, unknown>
          content: { 'application/json': Issue }
        }
      }
    }
    put?: never
    patch?: never
    delete?: never
  }
}

function checkTypes(client: HttpClient<GitHubApi>) {
  // @ts-expect-error Unknown GET endpoint
  void client.get('/users')

  // @ts-expect-error Path parameters are required
  void client.get('/repos/{owner}/{repo}')

  void client.get('/repos/{owner}/{repo}', {
    params: { owner: 'adonisjs', repo: 'core' },
    // @ts-expect-error OpenAPI query types are enforced
    query: { page: 'one' },
  })

  void client.post('/repos/{owner}/{repo}/issues', {
    params: { owner: 'adonisjs', repo: 'core' },
    // @ts-expect-error OpenAPI request body types are enforced
    json: { name: 'Missing title' },
  })
}

void checkTypes

test.group('OpenAPI types', () => {
  test('types a named client and interpolates OpenAPI path parameters', async ({
    assert,
    expectTypeOf,
  }) => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 1, name: request.url, private: false }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port')
    }

    const manager = new HttpClientManager({
      default: 'github',
      clients: {
        github: defineHttpClient<GitHubApi>({
          baseUrl: `http://127.0.0.1:${address.port}`,
        }),
        internal: { baseUrl: `http://127.0.0.1:${address.port}` },
      },
    })

    try {
      const github = manager.use('github')
      expectTypeOf(github).toEqualTypeOf<HttpClient<GitHubApi>>()
      expectTypeOf(manager.use()).toEqualTypeOf<HttpClient<GitHubApi>>()
      expectTypeOf(manager.use('internal')).toEqualTypeOf<HttpClient>()

      const response = await github.get('/repos/{owner}/{repo}', {
        params: { owner: 'adonisjs', repo: 'core' },
        query: { page: 1 },
      })

      expectTypeOf(response.json()).toEqualTypeOf<Repository | NotFound>()
      const successfulResponse = response.throwIfFailed()
      expectTypeOf(successfulResponse.json()).toEqualTypeOf<Repository>()
      assert.equal(successfulResponse.json().name, '/repos/adonisjs/core?page=1')
    } finally {
      await manager.close()
      server.close()
      await once(server, 'close')
    }
  })
})
