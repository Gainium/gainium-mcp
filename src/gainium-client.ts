import * as crypto from "crypto";

export interface GainiumResponse<T = any> {
  status: "OK" | "NOTOK";
  reason: string | null;
  data: T;
  meta?: {
    page: number;
    total: number;
    count: number;
    onPage: number;
    fields?: string[];
  };
  errors?: string[][];
}

// Format a Gainium API error payload into a readable string. The API sometimes returns
// `reason` as an object and/or a separate `errors` structure; naive String(reason) yields
// "[object Object]" and hides the real cause (e.g. which pair failed validation).
function formatApiError(status: number | string, payload: any): string {
  const reason = payload?.reason;
  const reasonStr =
    reason == null
      ? ""
      : typeof reason === "string"
        ? reason
        : JSON.stringify(reason);
  const errors = payload?.errors;
  const errorsStr = errors
    ? ` Details: ${typeof errors === "string" ? errors : JSON.stringify(errors)}`
    : "";
  const base = reasonStr || `HTTP ${status}`;
  return `Gainium API error: ${base}${errorsStr}`;
}

export type QueryValue =
  | string
  | number
  | boolean
  | string[]
  | undefined
  | null;

export class GainiumClient {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(baseUrl: string, apiKey: string, apiSecret: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    options?: {
      query?: Record<string, QueryValue>;
      body?: Record<string, any>;
      headers?: Record<string, string>;
    }
  ): Promise<GainiumResponse<T>> {
    // Build query string
    const params = new URLSearchParams();
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
          for (const v of value) {
            params.append(key, v);
          }
        } else {
          params.append(key, String(value));
        }
      }
    }

    const queryString = params.toString() ? `?${params.toString()}` : "";
    const fullEndpoint = endpoint + queryString;
    const url = `${this.baseUrl}${fullEndpoint}`;

    const timestamp = Date.now();
    const bodyStr =
      options?.body && method !== "GET" ? JSON.stringify(options.body) : "";

    // Signature: HMAC-SHA256 of {body + method + endpoint + timestamp}
    const prehash = bodyStr + method + fullEndpoint + timestamp;
    const signature = crypto
      .createHmac("sha256", this.apiSecret)
      .update(prehash)
      .digest("base64");

    console.error(`[Gainium API] ${method} ${fullEndpoint}`);

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        token: this.apiKey,
        time: timestamp.toString(),
        signature: signature,
        ...(options?.headers || {}),
      },
    };

    if (bodyStr) {
      fetchOptions.body = bodyStr;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(errorText);
      } catch {
        throw new Error(
          `Gainium API error ${response.status}: ${errorText}`
        );
      }
      if (parsed?.reason || parsed?.errors) {
        throw new Error(formatApiError(response.status, parsed));
      }
      throw new Error(
        `Gainium API error ${response.status}: ${response.statusText}`
      );
    }

    const data = (await response.json()) as GainiumResponse<T>;

    if (data.status === "NOTOK") {
      throw new Error(formatApiError("NOTOK", data));
    }

    return data;
  }
}
