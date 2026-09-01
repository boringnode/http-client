import type { HttpClientOptions, HttpMethod, RawBody, RequestOptions } from './types/main.js'

declare const apiTypes: unique symbol

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'TRACE'
type LowercaseMethod<Method extends HttpMethod> = Lowercase<Method> & Lowercase<ApiMethod>

/** A client configuration carrying a type-only OpenAPI contract. */
export type HttpClientDefinition<Api> = HttpClientOptions & {
  readonly [apiTypes]?: Api
}

/** Attach an OpenAPI `paths` type to a client configuration. */
export function defineHttpClient<Api>(options: HttpClientOptions): HttpClientDefinition<Api> {
  return options
}

export type InferClientApi<Definition> = typeof apiTypes extends keyof Definition
  ? Definition extends HttpClientDefinition<infer Api>
    ? Api
    : never
  : never

type OperationAt<Api, Method extends HttpMethod, Path extends keyof Api> =
  LowercaseMethod<Method> extends keyof Api[Path]
    ? Exclude<Api[Path][LowercaseMethod<Method>], undefined>
    : never

type OpenApiPath<Api, Method extends HttpMethod> = {
  [Path in keyof Api & string]: [OperationAt<Api, Method, Path>] extends [never] ? never : Path
}[keyof Api & string]

export type ClientPath<Api, Method extends HttpMethod> = [Api] extends [never]
  ? string | URL
  : OpenApiPath<Api, Method>

type ParametersOf<Operation> = Operation extends { parameters: infer Parameters }
  ? Parameters
  : Operation extends { parameters?: infer Parameters }
    ? NonNullable<Parameters>
    : never

type ParameterGroup<
  Operation,
  Group extends PropertyKey,
> = Group extends keyof ParametersOf<Operation>
  ? Exclude<ParametersOf<Operation>[Group], undefined>
  : never

type MergeParameterGroups<PathItem, Operation, Group extends PropertyKey> = [
  ParameterGroup<PathItem, Group>,
] extends [never]
  ? ParameterGroup<Operation, Group>
  : [ParameterGroup<Operation, Group>] extends [never]
    ? ParameterGroup<PathItem, Group>
    : ParameterGroup<PathItem, Group> & ParameterGroup<Operation, Group>

type OperationWithPathParameters<Api, Method extends HttpMethod, Path extends keyof Api> = Omit<
  OperationAt<Api, Method, Path>,
  'parameters'
> & {
  parameters: {
    path: MergeParameterGroups<Api[Path], OperationAt<Api, Method, Path>, 'path'>
    query: MergeParameterGroups<Api[Path], OperationAt<Api, Method, Path>, 'query'>
  }
}

type RequiredKeys<Value> = Value extends object
  ? {
      [Key in keyof Value]-?: object extends Pick<Value, Key> ? never : Key
    }[keyof Value]
  : never

type PathOption<Operation> = [ParameterGroup<Operation, 'path'>] extends [never]
  ? { params?: never }
  : { params: ParameterGroup<Operation, 'path'> }

type QueryOption<Operation> = [ParameterGroup<Operation, 'query'>] extends [never]
  ? { query?: never }
  : [RequiredKeys<ParameterGroup<Operation, 'query'>>] extends [never]
    ? { query?: ParameterGroup<Operation, 'query'> }
    : { query: ParameterGroup<Operation, 'query'> }

type RequestBodyOf<Operation> = Operation extends { requestBody: infer Body }
  ? Body
  : Operation extends { requestBody?: infer Body }
    ? Exclude<Body, undefined>
    : never

type ContentOf<Value> = Value extends { content: infer Content } ? Content : never

type JsonContent<Content> = Content extends object
  ? {
      [MediaType in keyof Content]: MediaType extends `${string}/json` | `${string}+json`
        ? Content[MediaType]
        : never
    }[keyof Content]
  : never

type JsonRequestBody<Operation> = JsonContent<ContentOf<RequestBodyOf<Operation>>>

type BodyOption<Operation> = [JsonRequestBody<Operation>] extends [never]
  ? { body?: RawBody; json?: never }
  : Operation extends { requestBody: unknown }
    ? { body?: never; json: JsonRequestBody<Operation> }
    : { body?: never; json?: JsonRequestBody<Operation> }

type CommonRequestOptions = Omit<RequestOptions, 'body' | 'json' | 'params' | 'query'>

export type ClientRequestOptions<
  Api,
  Method extends HttpMethod,
  Path extends ClientPath<Api, Method>,
> = [Api] extends [never]
  ? RequestOptions
  : CommonRequestOptions &
      PathOption<OperationWithPathParameters<Api, Method, Path & keyof Api>> &
      QueryOption<OperationWithPathParameters<Api, Method, Path & keyof Api>> &
      BodyOption<OperationAt<Api, Method, Path & keyof Api>>

export type ClientRequestArguments<
  Api,
  Method extends HttpMethod,
  Path extends ClientPath<Api, Method>,
> =
  object extends ClientRequestOptions<Api, Method, Path>
    ? [options?: ClientRequestOptions<Api, Method, Path>]
    : [options: ClientRequestOptions<Api, Method, Path>]

type ResponsesOf<Operation> = Operation extends { responses: infer Responses } ? Responses : never

type IsFailureStatus<Status> = Status extends number
  ? `${Status}` extends `4${string}` | `5${string}`
    ? true
    : false
  : Status extends string
    ? Uppercase<Status> extends `4${string}` | `5${string}`
      ? true
      : Lowercase<Status> extends 'default'
        ? boolean
        : false
    : false

type ResponseBody<Responses, Failure extends boolean> = Responses extends object
  ? {
      [Status in keyof Responses]: boolean extends IsFailureStatus<Status>
        ? JsonContent<ContentOf<Responses[Status]>>
        : IsFailureStatus<Status> extends Failure
          ? JsonContent<ContentOf<Responses[Status]>>
          : never
    }[keyof Responses]
  : never

export type ClientSuccessBody<
  Api,
  Method extends HttpMethod,
  Path extends ClientPath<Api, Method>,
> = [Api] extends [never]
  ? unknown
  : ResponseBody<ResponsesOf<OperationAt<Api, Method, Path & keyof Api>>, false>

export type ClientErrorBody<
  Api,
  Method extends HttpMethod,
  Path extends ClientPath<Api, Method>,
> = [Api] extends [never]
  ? unknown
  : ResponseBody<ResponsesOf<OperationAt<Api, Method, Path & keyof Api>>, true>
