/**
 * The SPA's ONLY network layer. Two responsibilities:
 *
 * 1. Token (Jupyter model, reused from the web-api bootstrap contract): `gregorian ui` opens the page with
 *    `?token=<token>` in the URL. We read it once, stash it in sessionStorage, and strip it from the address
 *    bar (so it can't linger in history or leak via Referer). Every request sends `Authorization: Bearer`.
 * 2. Typed, NAMED errors so the UI never fails silently. A non-2xx becomes an `ApiError` carrying the status
 *    and the daemon's message; an unreachable daemon becomes a `NetworkError`. Callers render these visibly.
 */

import type { GregorianEvent, Run, CreateEventBody, TranscriptResult } from "./types";

const TOKEN_KEY = "gregorian.token";

/** Read the token from `?token=` (first load) or sessionStorage (subsequent navigations); null if neither. */
export function resolveToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

/** A non-2xx response. `status` lets the UI special-case 401 (stale token → re-run `gregorian ui`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The daemon couldn't be reached at all (down, restarting, network). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

/** Pull the most useful human message out of an error response body (JSON `{error}`/`{message}` or text). */
async function errorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status} ${res.statusText}`;
    try {
      const json = JSON.parse(text) as { error?: string; message?: string };
      return json.error ?? json.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : "could not reach the daemon");
  }
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  return (await res.json()) as T;
}

export function listEvents(): Promise<{ events: GregorianEvent[] }> {
  return request("/events", { headers: authHeaders() });
}

export function listRuns(): Promise<{ runs: Run[] }> {
  return request("/runs", { headers: authHeaders() });
}

export function getEvent(id: string): Promise<{ event: GregorianEvent; runs: Run[] }> {
  return request(`/events/${encodeURIComponent(id)}`, { headers: authHeaders() });
}

/** One run's normalized transcript. The route keys on the run `id` (store.getRun); 404 only for an
 *  unknown id, while a degraded read returns 200 with `transcript.reason` set. */
export function getTranscript(runId: string): Promise<{ transcript: TranscriptResult }> {
  return request(`/runs/${encodeURIComponent(runId)}/transcript`, { headers: authHeaders() });
}

export function createEvent(body: CreateEventBody): Promise<{ event: GregorianEvent }> {
  return request("/events", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}
