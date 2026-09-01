import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from '@japa/runner'
import { Agent, errors as undiciErrors } from 'undici'
import { HttpClient } from '../src/http_client.js'
import { HttpError, ResponseTooLargeError } from '../src/exceptions.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

async function startServer(handler: Handler) {
  const sockets = new Set<IncomingMessage['socket']>()
  const server = createServer(async (request, response) => {
    sockets.add(request.socket)
    await handler(request, response)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected the test server to listen on a TCP port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sockets,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

test.group('HttpClient', () => {
  test('sends requests with base URL, merged headers, query, and JSON', async ({ assert }) => {
    const server = await startServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          requestId: request.headers['x-request-id'],
          contentType: request.headers['content-type'],
          body: await readBody(request),
        })
      )
    })
    const client = new HttpClient({
      baseUrl: server.baseUrl,
      headers: { 'authorization': 'Bearer token', 'x-request-id': 'default' },
      query: { locale: 'en', page: 1 },
    })

    try {
      const response = await client.post('/users?existing=yes', {
        headers: { 'X-Request-ID': 'request' },
        query: { page: 2, tag: ['node', 'http'] },
        json: { name: 'Romain' },
      })

      assert.equal(response.status, 200)
      assert.equal(response.header('Content-Type'), 'application/json')
      assert.deepEqual(response.json(), {
        method: 'POST',
        url: '/users?existing=yes&locale=en&page=2&tag=node&tag=http',
        authorization: 'Bearer token',
        requestId: 'request',
        contentType: 'application/json',
        body: '{"name":"Romain"}',
      })
      assert.equal(response.text(), new TextDecoder().decode(response.bytes()))
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('supports absolute URLs, raw bodies, and every convenience method', async ({ assert }) => {
    const server = await startServer(async (request, response) => {
      response.end(`${request.method}:${await readBody(request)}`)
    })
    const client = new HttpClient()

    try {
      assert.equal((await client.get(server.baseUrl)).text(), 'GET:')
      assert.equal((await client.post(server.baseUrl, { body: 'post' })).text(), 'POST:post')
      assert.equal((await client.put(server.baseUrl, { body: 'put' })).text(), 'PUT:put')
      assert.equal((await client.patch(server.baseUrl, { body: 'patch' })).text(), 'PATCH:patch')
      assert.equal((await client.delete(server.baseUrl)).text(), 'DELETE:')
      assert.equal((await client.request('OPTIONS', server.baseUrl)).text(), 'OPTIONS:')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('keeps HTTP failures as responses until throwIfFailed is called', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      response.statusCode = 404
      response.end('missing')
    })
    const client = new HttpClient({ baseUrl: server.baseUrl })

    try {
      const response = await client.get('/')
      assert.isTrue(response.failed())
      assert.equal(response.text(), 'missing')
      assert.throws(() => response.throwIfFailed(), HttpError)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('enforces a total request timeout', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      setTimeout(() => response.end('late'), 100)
    })
    const client = new HttpClient({ timeout: 20 })

    try {
      await assert.rejects(() => client.get(server.baseUrl), DOMException)
    } finally {
      await client.destroy()
      await server.close()
    }
  })

  test('keeps header inactivity timeout separate from total timeout', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      setTimeout(() => response.end('late'), 1_500)
    })
    const client = new HttpClient({ timeout: 0, headersTimeout: 50 })

    try {
      await assert.rejects(() => client.get(server.baseUrl), undiciErrors.HeadersTimeoutError)
    } finally {
      await client.destroy()
      await server.close()
    }
  })

  test('rejects network failures', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      response.end()
    })
    const client = new HttpClient()
    await server.close()

    try {
      await assert.rejects(() => client.get(server.baseUrl), Error)
    } finally {
      await client.destroy()
    }
  })

  test('stops buffering responses over the configured limit', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      response.end('123456')
    })
    const client = new HttpClient({ baseUrl: server.baseUrl, maxResponseSize: 5 })

    try {
      await assert.rejects(() => client.get('/'), ResponseTooLargeError)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('returns an explicit unconsumed streaming response', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      response.write('one')
      response.end('two')
    })
    const client = new HttpClient({ baseUrl: server.baseUrl, maxResponseSize: 1 })

    try {
      const response = await client.stream('/')
      const chunks: Buffer[] = []
      for await (const chunk of response.body) {
        chunks.push(Buffer.from(chunk))
      }

      assert.equal(Buffer.concat(chunks).toString(), 'onetwo')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('follows redirects and can return them without following', async ({ assert }) => {
    const server = await startServer((request, response) => {
      if (request.url === '/redirect') {
        response.statusCode = 302
        response.setHeader('location', '/final')
        response.end()
        return
      }

      response.end('redirected')
    })
    const client = new HttpClient({ baseUrl: server.baseUrl })

    try {
      assert.equal((await client.get('/redirect')).text(), 'redirected')
      assert.equal((await client.get('/redirect', { maxRedirects: 0 })).status, 302)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('does not leak client defaults to another origin', async ({ assert }) => {
    const target = await startServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ authorization: request.headers.authorization, url: request.url })
      )
    })
    const source = await startServer((_request, response) => {
      response.statusCode = 302
      response.setHeader('location', `${target.baseUrl}/target`)
      response.end()
    })
    const client = new HttpClient({
      baseUrl: source.baseUrl,
      headers: { authorization: 'Bearer secret' },
      query: { token: 'secret' },
    })

    try {
      assert.deepEqual((await client.get('/redirect')).json(), { url: '/target' })
      assert.deepEqual((await client.get(`${target.baseUrl}/direct`)).json(), { url: '/direct' })
    } finally {
      await client.close()
      await source.close()
      await target.close()
    }
  })

  test('reuses the default Agent connection', async ({ assert }) => {
    const server = await startServer((_request, response) => {
      response.end('ok')
    })
    const client = new HttpClient({ baseUrl: server.baseUrl, transport: { connections: 1 } })

    try {
      await client.get('/')
      await client.get('/')
      assert.equal(server.sockets.size, 1)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('shares dispatchers with derived clients and respects ownership', async ({ assert }) => {
    const server = await startServer((request, response) => {
      response.end(request.headers.authorization)
    })
    const ownedAgent = new Agent()
    const parent = new HttpClient({ baseUrl: server.baseUrl, dispatcher: () => ownedAgent })
    const derived = parent.withOptions({ headers: { authorization: 'Bearer token' } })

    try {
      assert.equal((await derived.get('/')).text(), 'Bearer token')
      await derived.close()
      assert.isFalse(ownedAgent.closed)
      await parent.close()
      assert.isTrue(ownedAgent.closed)

      const borrowedAgent = new Agent()
      const borrowed = new HttpClient({ dispatcher: borrowedAgent })
      await borrowed.close()
      assert.isFalse(borrowedAgent.closed)
      await borrowedAgent.close()
    } finally {
      await parent.close()
      await server.close()
    }
  })
})
