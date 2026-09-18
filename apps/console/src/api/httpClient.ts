import {
  createApiError,
  type ApiErrorCode,
  type ApiErrorResponse,
  type CancelRunRequest,
  type CancelRunResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type GetRunEventsQuery,
  type GetRunEventsResponse,
  type GetRunResponse,
  type IRunApiClient,
  type ListRunsQuery,
  type ListRunsResponse,
} from "@aegis/contracts";
import { err, ok, type Result } from "@aegis/types";

export interface HttpRunApiClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  getHeaders?: () => Record<string, string>;
}

/**
 * Concrete HTTP implementation of IRunApiClient for the Aegis Console.
 * Connects the React application to the Fastify API service.
 */
export class HttpRunApiClient implements IRunApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getHeaders?: () => Record<string, string>;

  constructor(config: HttpRunApiClientConfig = {}) {
    const defaultBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

    this.baseUrl = config.baseUrl ?? defaultBaseUrl;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.getHeaders = config.getHeaders;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const normalizedBase = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${normalizedBase}${normalizedPath}`);

    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined) {
          url.searchParams.set(key, String(val));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    options: RequestInit,
    query?: Record<string, string | number | undefined>,
  ): Promise<Result<T, ApiErrorResponse>> {
    const url = this.buildUrl(path, query);
    const customHeaders = this.getHeaders ? this.getHeaders() : {};

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...customHeaders,
      ...(options.headers as Record<string, string> | undefined),
    };

    try {
      const response = await this.fetchImpl(url, {
        ...options,
        headers,
      });

      const responseText = await response.text();
      let responseJson: unknown = null;
      if (responseText.length > 0) {
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          // Non-JSON payload
        }
      }

      if (!response.ok) {
        if (
          responseJson &&
          typeof responseJson === "object" &&
          "error" in responseJson &&
          responseJson.error &&
          typeof (responseJson as { error: { code?: unknown } }).error.code === "string"
        ) {
          return err(responseJson as ApiErrorResponse);
        }

        const statusCode = response.status;
        let code: ApiErrorCode = "BAD_REQUEST";
        if (statusCode === 404) code = "NOT_FOUND";
        else if (statusCode === 409) code = "CONFLICT";
        else if (statusCode === 401) code = "UNAUTHORIZED";
        else if (statusCode === 403) code = "FORBIDDEN";
        else if (statusCode === 422) code = "UNPROCESSABLE_ENTITY";
        else if (statusCode === 503) code = "SERVICE_UNAVAILABLE";
        else if (statusCode >= 500) code = "INTERNAL_SERVER_ERROR";

        const message =
          response.statusText.length > 0
            ? response.statusText
            : `HTTP request failed with status ${statusCode.toString()}`;

        return err(createApiError(code, message));
      }

      return ok(responseJson as T);
    } catch (networkError: unknown) {
      const message =
        networkError instanceof Error ? networkError.message : "Network request failed";
      return err(createApiError("SERVICE_UNAVAILABLE", message));
    }
  }

  async listRuns(query?: ListRunsQuery): Promise<Result<ListRunsResponse, ApiErrorResponse>> {
    const queryParams: Record<string, string | number | undefined> = {};
    if (query?.status) queryParams.status = query.status;
    if (query?.query) queryParams.query = query.query;
    if (query?.cursor) queryParams.cursor = query.cursor;
    if (query?.limit !== undefined) queryParams.limit = query.limit;

    return this.request<ListRunsResponse>("/runs", { method: "GET" }, queryParams);
  }

  async getRun(id: string): Promise<Result<GetRunResponse, ApiErrorResponse>> {
    return this.request<GetRunResponse>(`/runs/${encodeURIComponent(id)}`, { method: "GET" });
  }

  async createRun(request: CreateRunRequest): Promise<Result<CreateRunResponse, ApiErrorResponse>> {
    return this.request<CreateRunResponse>("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async cancelRun(
    id: string,
    request?: CancelRunRequest,
  ): Promise<Result<CancelRunResponse, ApiErrorResponse>> {
    return this.request<CancelRunResponse>(`/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request ?? {}),
    });
  }

  async getRunEvents(
    runId: string,
    query?: GetRunEventsQuery,
  ): Promise<Result<GetRunEventsResponse, ApiErrorResponse>> {
    const queryParams: Record<string, string | number | undefined> = {};
    if (query?.cursor) queryParams.cursor = query.cursor;
    if (query?.type) queryParams.type = query.type;
    if (query?.limit !== undefined) queryParams.limit = query.limit;
    if (query?.severity) queryParams.severity = query.severity;

    return this.request<GetRunEventsResponse>(
      `/runs/${encodeURIComponent(runId)}/events`,
      { method: "GET" },
      queryParams,
    );
  }
}
