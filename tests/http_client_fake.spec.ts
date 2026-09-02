import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from '@japa/runner'
import { HttpClientManager } from '../src/http_client_manager.js'

function checkFakeTypes(manager: HttpClientManager<{ github: { baseUrl: string } }, 'github'>) {
  const fake = manager.fake()

  // @ts-expect-error Unknown managed client
  fake.intercept('missing', { path: '/' })
}

void checkFakeTypes

test.group('HttpClientFake', () => {
  test('returns mocked responses and records resolved requests', async ({
    assert,
    expectTypeOf,
  }) => {
    const manager = new HttpClientManager({
      default: 'github',
      clients: {
        github: {
          baseUrl: 'https://api.github.test',
          headers: { authorization: 'Bearer token' },
          query: { locale: 'en' },
        },
        internal: { baseUrl: 'https://internal.test' },
      },
    })
    const fake = manager.fake()
    fake
      .intercept('github', {
        method: 'POST',
        path: '/repos?locale=en',
        headers: { authorization: 'Bearer token' },
        json: { name: 'http-client' },
      })
      .reply(201, { id: 1, name: 'http-client' })

    try {
      const response = await manager.post('/repos', {
        headers: { accept: ['application/json', 'text/plain'] },
        json: { name: 'http-client' },
      })

      assert.equal(response.status, 201)
      assert.equal(response.header('content-type'), 'application/json')
      assert.deepEqual(response.json(), { id: 1, name: 'http-client' })
      fake.assertSent('github', {
        method: 'POST',
        path: '/repos?locale=en',
        headers: {
          'accept': ['application/json', 'text/plain'],
          'authorization': 'Bearer token',
          'content-type': 'application/json',
        },
        json: { name: 'http-client' },
      })
      fake.assertNotSent('internal')
      fake.assertSentCount(1, { client: 'github' })
      fake.assertNothingPending()
      expectTypeOf(fake.requests[0].client).toEqualTypeOf<'github' | 'internal'>()

      const recordedHeaders = fake.requests[0].headers
      const accept = recordedHeaders.accept
      if (!Array.isArray(accept)) {
        throw new Error('Expected the recorded Accept header to be an array')
      }
      accept[0] = 'changed'
      assert.deepEqual(fake.requests[0].headers.accept, ['application/json', 'text/plain'])
    } finally {
      await fake.restore()
      await manager.close()
    }
  })

  test('matches JSON and query parameters by value', async ({ assert }) => {
    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: 'https://api.test' } },
    })
    const fake = manager.fake()
    fake
      .intercept('api', {
        method: 'POST',
        path: '/items?second=2&first=1',
        json: { first: 1, second: 2 },
      })
      .reply(200, 'matched')

    try {
      const response = await manager.post('/items?first=1&second=2', {
        json: { second: 2, first: 1 },
      })
      assert.equal(response.text(), 'matched')
      fake.assertSent('api', { path: '/items?second=2&first=1' })
    } finally {
      await fake.restore()
      await manager.close()
    }
  })

  test('follows mocked redirects and records every dispatched request', async ({ assert }) => {
    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: 'https://api.test' } },
    })
    const fake = manager.fake()
    fake.intercept('api', { path: '/redirect' }).reply(302, undefined, { location: '/final' })
    fake.intercept('api', { path: '/final' }).reply(200, 'redirected')

    try {
      assert.equal((await manager.get('/redirect')).text(), 'redirected')
      assert.deepEqual(
        fake.requests.map((request) => request.url),
        ['https://api.test/redirect', 'https://api.test/final']
      )
      fake.assertNothingPending()
    } finally {
      await fake.restore()
      await manager.close()
    }
  })

  test('blocks unmatched network requests but still records them', async ({ assert }) => {
    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: 'https://api.test' } },
    })
    const fake = manager.fake()

    try {
      await assert.rejects(() => manager.get('/missing'), /Mock dispatch not matched/)
      fake.assertSent('api', { method: 'GET', path: '/missing' })
    } finally {
      await fake.restore()
      await manager.close()
    }
  })

  test('switches existing and derived clients to the fake, then restores them', async ({
    assert,
  }) => {
    const server = createServer((_request, response) => response.end('real'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port')
    }

    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: `http://127.0.0.1:${address.port}` } },
    })
    const realClient = manager.use()
    const derivedClient = realClient.withOptions({ headers: { authorization: 'Bearer token' } })

    try {
      {
        await using fake = manager.fake()
        fake.intercept('api', { path: '/manager' }).reply(200, 'manager')
        fake.intercept('api', { path: '/captured' }).reply(200, 'captured')
        fake
          .intercept('api', { path: '/derived', headers: { authorization: 'Bearer token' } })
          .reply(200, 'derived')

        assert.strictEqual(manager.use(), realClient)
        assert.equal((await manager.get('/manager')).text(), 'manager')
        assert.equal((await realClient.get('/captured')).text(), 'captured')
        assert.equal((await derivedClient.get('/derived')).text(), 'derived')
        fake.assertSentCount(3, { client: 'api' })
      }

      assert.strictEqual(manager.use(), realClient)
      assert.equal((await manager.get('/')).text(), 'real')
    } finally {
      await manager.close()
      server.close()
      await once(server, 'close')
    }
  })

  test('rejects overlapping fake scopes', async ({ assert }) => {
    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: 'https://api.test' } },
    })
    const fake = manager.fake()

    try {
      assert.throws(() => manager.fake(), /A fake is already active or being restored/)
    } finally {
      const firstRestoration = fake.restore()
      assert.strictEqual(fake.restore(), firstRestoration)
      assert.throws(() => manager.fake(), /A fake is already active or being restored/)
      await firstRestoration
      await manager.fake().restore()
      await manager.close()
    }
  })

  test('destroy aborts active mocked requests', async ({ assert }) => {
    const manager = new HttpClientManager({
      default: 'api',
      clients: { api: { baseUrl: 'https://api.test' } },
    })
    const fake = manager.fake()
    fake.intercept('api', { path: '/slow' }).reply(200, 'late').delay(5_000)
    const failure = new Error('Test shutdown')
    const request = manager.get('/slow').then(
      () => undefined,
      (error: unknown) => error
    )

    await manager.destroy(failure)

    assert.strictEqual(await request, failure)
  })
})
