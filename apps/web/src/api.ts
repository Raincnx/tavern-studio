let csrfToken = '';

export class ApiError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

export async function session(): Promise<void> {
  const response = await fetch('/api/v1/session', { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('无法建立本地会话，请通过 127.0.0.1 打开应用', 'SESSION_FAILED');
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
}

export async function api<Result>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Result> {
  const idempotencyKey = crypto.randomUUID();
  const send = () => fetch(`/api/v1${path}`, { method, signal, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-tavern-csrf': csrfToken, 'idempotency-key': idempotencyKey }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let response = await send();
  if (response.status === 401) { await session(); response = await send(); }
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.message ?? '请求失败', payload.code ?? 'UNKNOWN_ERROR');
  return payload as Result;
}
