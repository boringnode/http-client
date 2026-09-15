# @boringnode/http-client

<div align="center">

[![typescript-image]][typescript-url]
[![gh-workflow-image]][gh-workflow-url]
[![npm-image]][npm-url]
[![npm-download-image]][npm-download-url]
[![license-image]][license-url]

</div>

A small HTTP client for Node.js built on [Undici](https://undici.nodejs.org). It provides reusable
client configuration, named clients, typed OpenAPI requests, and an in-memory transport for tests.

## Installation

```bash
npm install @boringnode/http-client
```

## Features

- **Named clients**: Configure several APIs and access them through `HttpClientManager`
- **Client defaults**: Reuse base URLs, headers, query parameters, and timeouts
- **Typed OpenAPI requests**: Infer paths, parameters, JSON bodies, and responses from an OpenAPI
  `paths` type
- **Buffered responses**: Read response bodies more than once with a configurable size limit
- **Explicit streaming**: Stream large responses without buffering them in memory
- **Derived clients**: Add request defaults while sharing the parent dispatcher's connection pool
- **Request fakes**: Intercept requests and assert against them without network access
- **Managed connections**: Configure Undici dispatchers and close owned connections cleanly

## Quick Start

### Create a client

```typescript
import { HttpClient } from '@boringnode/http-client'

const http = new HttpClient({
  baseUrl: 'https://api.example.com',
  headers: { authorization: `Bearer ${token}` },
  timeout: 10_000,
})

const response = await http.get('/users', {
  query: { page: 1 },
})

response.throwIfFailed()
const users = response.json<User[]>()

await http.close()
```

HTTP 4xx and 5xx statuses remain normal responses. Network errors and timeouts reject the request.
Call `throwIfFailed()` when a non-success status should throw.

### Configure named clients

```typescript
import { HttpClientManager } from '@boringnode/http-client'

const http = new HttpClientManager({
  default: 'github',
  clients: {
    github: {
      baseUrl: 'https://api.github.com',
      headers: { authorization: `Bearer ${token}` },
      timeout: 10_000,
    },
  },
})

const response = await http.get('/repos/boringnode/http-client')
const repository = response.throwIfFailed().json<Repository>()

await http.close()
```

`use(name?)` creates each named client on first use and caches it. The manager also forwards
`request`, `get`, `post`, `put`, `patch`, `delete`, and `stream` to its default client.

## Why Not Use `fetch`?

Node.js `fetch` is powered by Undici and remains the best choice for isolated requests or code that
needs the Web Fetch API. This package uses Undici's lower-level dispatcher API to add application
conventions without changing its global dispatcher.

Compared with `fetch`, the package provides:

- reusable client defaults for base URLs, headers, query parameters, and timeouts
- named clients through `HttpClientManager`
- immutable derived clients that share the same dispatcher
- buffered, repeatable response readers with a maximum body size
- explicit HTTP failure handling through `failed()` and `throwIfFailed()`
- an explicit streaming API with documented body ownership
- per-client dispatcher and connection settings with owned lifecycle management

`fetch` already pools connections through Undici, follows redirects, supports streaming, and works
with `AbortSignal`. This package does not replace those capabilities. It gives them a reusable,
typed client configuration and lifecycle for applications that make more than occasional requests.

## Client Configuration

```typescript
import { HttpClientManager } from '@boringnode/http-client'

const http = new HttpClientManager({
  default: 'github',
  clients: {
    github: {
      baseUrl: 'https://api.github.com',
      headers: { authorization: `Bearer ${token}` },
      query: { apiVersion: '2022-11-28' },
      timeout: 10_000,
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    },
  },
})

const response = await http.use().get('/repos/adonisjs/core')
response.throwIfFailed()
const repository = response.json<Repository>()

await http.close()
```

`use(name?)` creates each client on first use and caches it. The manager also forwards `request`,
`get`, `post`, `put`, `patch`, `delete`, and `stream` to its default client.

The generic request method takes the HTTP method first:

```typescript
await http.request('OPTIONS', '/health')
```

## Testing

`HttpClientManager.fake()` switches its managed clients to isolated in-memory transports. This also
affects clients obtained before `fake()` and clients created from them with `withOptions()`. Real
network connections are disabled while the fake is active, so every request needs a matching
interceptor. Fake scopes cannot overlap.

```typescript
test('creates a repository', async () => {
  await using fake = http.fake()

  fake
    .intercept('github', {
      method: 'POST',
      path: '/repos',
      json: { name: 'http-client' },
    })
    .reply(201, { id: 1, name: 'http-client' })

  await createRepository('http-client')

  fake.assertSent('github', {
    method: 'POST',
    path: '/repos',
    json: { name: 'http-client' },
  })
  fake.assertSentCount(1, { client: 'github' })
  fake.assertNothingPending()
})
```

Relative interceptor and assertion paths resolve against the named client's `baseUrl`. Query
parameter order does not affect matching. JSON bodies are compared by value. Response objects are
serialized as JSON and receive an `application/json` content type unless one is provided. Use
`replyWithError(error)` to simulate a transport failure. A reply is consumed once by default;
append `times(count)` or `persist()` when it should handle more requests.

The fake records resolved URLs, methods, headers, and buffered bodies in `fake.requests`. Streaming
and form-data bodies are not retained. `clear()` empties that history. `assertSent`, `assertNotSent`,
`assertSentCount`, and `assertNothingSent` inspect it. Call `assertNothingPending()` to ensure every
configured interceptor was consumed.

`await using` restores the clients that existed before fake mode and closes the in-memory
transports. Call `await fake.restore()` or `await http.restore()` when explicit cleanup is more
convenient.

## OpenAPI Types

The client can use a `paths` type generated by
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript). The generated types remain
type-only and add no runtime dependency.

```bash
npx openapi-typescript ./github.openapi.yaml -o ./github.openapi.ts
```

Attach the generated type to a named client with `defineHttpClient`:

```typescript
import type { paths as GitHubApi } from './github.openapi.js'
import { defineHttpClient, HttpClientManager } from '@boringnode/http-client'

const http = new HttpClientManager({
  default: 'github',
  clients: {
    github: defineHttpClient<GitHubApi>({
      baseUrl: 'https://api.github.com',
      headers: { authorization: `Bearer ${token}` },
    }),
  },
})

const response = await http.use('github').get('/repos/{owner}/{repo}', {
  params: { owner: 'adonisjs', repo: 'core' },
})

const repository = response.throwIfFailed().json()
//    ^? Repository
```

The method and path control the available path parameters, query parameters, JSON body, and JSON
response type. Before `throwIfFailed()`, `json()` includes the declared success and error bodies.
After it, `json()` contains only response bodies for statuses below 400.

OpenAPI types provide compile-time checks only. They do not validate a server response at runtime.
Path interpolation currently implements the common `{parameter}` form, and request bodies are typed
when the operation declares a JSON media type.

## Request Bodies

Use `json` for JSON and `body` for strings, bytes, form data, or Node.js readable streams.

```typescript
await http.use('github').post('/repos/boringnode/example/issues', {
  json: { title: 'Connection failed' },
})

await http.use('github').put('/upload', {
  body: Buffer.from('contents'),
  headers: { 'content-type': 'application/octet-stream' },
})
```

The buffered response API is synchronous after the request resolves:

```typescript
response.status
response.headers
response.header('content-type')
response.text()
response.json()
response.bytes()
response.failed()
response.throwIfFailed()
```

The default response limit is 10 MiB. Set `maxResponseSize` on a client or derived client to change
it. An oversized response throws `errors.ResponseTooLargeError` and discards its connection.

## Derived Clients

`withOptions` creates an immutable derived client. Headers and query values merge with the parent,
and the derived client borrows the same dispatcher.

```typescript
const authenticated = httpClient.withOptions({
  headers: { authorization: `Bearer ${token}` },
})

await authenticated.get('/profile')
```

Closing a derived client does not close the shared dispatcher. Close its owning parent instead.

When `baseUrl` is configured, default headers and query parameters apply only to requests on the
same origin. Request-specific options still apply to any URL. This prevents credentials configured
for one API from being sent to another origin.

## Timeouts and Redirects

`timeout` limits the total request duration. `headersTimeout` limits the time spent waiting for
complete response headers, and `bodyTimeout` limits inactivity between body chunks. Set any timeout
to `0` to disable it.

```typescript
const http = new HttpClient({
  timeout: 30_000,
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
})
```

The client follows up to five redirects by default. Set `maxRedirects` on the client or a request to
change the limit, or set it to `0` to receive redirect responses unchanged. Undici removes
`authorization`, `cookie`, and `proxy-authorization` when a redirect changes origin.

## Streaming

`stream` skips the response limit and returns Undici's readable body. The caller owns that body and
must consume, dump, or destroy it so the connection can be reused.

```typescript
const response = await httpClient.stream('/archive')

for await (const chunk of response.body) {
  process.stdout.write(chunk)
}
```

Pass `method` and the normal request options when streaming a non-GET request.

## Dispatchers and Lifecycle

Each client creates one long-lived Undici `Agent` by default. The package never changes Undici's
global dispatcher and never creates a dispatcher per request.

```typescript
import { Agent } from 'undici'

const borrowed = new HttpClient({ dispatcher: existingDispatcher })

const owned = new HttpClient({
  dispatcher: () => new Agent({ connections: 4 }),
})
```

A dispatcher instance is borrowed. `close()` and `destroy()` leave it open. A dispatcher returned by
a factory is owned and closed by the client. The default Agent is owned too. `close()` drains active
requests, while `destroy()` aborts them.

The `transport` option exposes common Agent connection settings. Inject a dispatcher for more
specialized Undici setups.

[gh-workflow-image]: https://img.shields.io/github/actions/workflow/status/boringnode/http-client/checks.yml?branch=main&style=for-the-badge
[gh-workflow-url]: https://github.com/boringnode/http-client/actions/workflows/checks.yml
[npm-image]: https://img.shields.io/npm/v/@boringnode/http-client.svg?style=for-the-badge&logo=npm
[npm-url]: https://www.npmjs.com/package/@boringnode/http-client
[npm-download-image]: https://img.shields.io/npm/dm/@boringnode/http-client?style=for-the-badge
[npm-download-url]: https://www.npmjs.com/package/@boringnode/http-client
[typescript-image]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org
[license-image]: https://img.shields.io/npm/l/@boringnode/http-client?color=blueviolet&style=for-the-badge
[license-url]: LICENSE.md
