import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from '@japa/runner'
import { Agent } from 'undici'
import { HttpClient } from '../src/http_client.js'
import { HttpClientManager } from '../src/http_client_manager.js'

test.group('HttpClientManager', () => {
  test('creates, types, and caches named clients', async ({ assert, expectTypeOf }) => {
    const manager = new HttpClientManager({
      default: 'github',
      clients: {
        github: { baseUrl: 'https://api.github.com' },
        internal: { baseUrl: 'https://internal.example.com' },
      },
    })

    expectTypeOf(manager.use).parameter(0).toEqualTypeOf<'github' | 'internal' | undefined>()
    expectTypeOf(manager.use('github')).toEqualTypeOf<HttpClient>()
    assert.strictEqual(manager.use(), manager.use('github'))
    assert.notStrictEqual(manager.use('github'), manager.use('internal'))
    await manager.close()
  })

  test('delegates requests to the default client and closes owned clients', async ({ assert }) => {
    const server = createServer((_request, response) => response.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port')
    }

    const agent = new Agent()
    const manager = new HttpClientManager({
      default: 'local',
      clients: {
        local: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          dispatcher: () => agent,
        },
      },
    })

    try {
      assert.equal((await manager.get('/')).text(), 'ok')
      assert.isFalse(agent.closed)
    } finally {
      await manager.close()
      assert.isTrue(agent.closed)
      server.close()
      await once(server, 'close')
    }
  })

  test('fails for missing default and unknown clients', async ({ assert }) => {
    const manager = new HttpClientManager({ clients: { github: {} } })
    assert.throws(
      () => manager.use(),
      'Cannot create HTTP client. No default client is defined in the config'
    )

    assert.throws(
      () => manager.use('missing' as 'github'),
      'Cannot create HTTP client. Client "missing" is not defined'
    )
    await manager.close()
  })
})
