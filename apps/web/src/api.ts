export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/v1' + path, {
    method,
    headers: {
      'x-demo-reel': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      'SERVICE_UNAVAILABLE',
      '서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }
  if (!response.ok)
    throw new ApiError(
      result.error?.code ?? 'ERROR',
      result.error?.message ?? '요청을 처리하지 못했습니다.',
    );
  return result;
}
export async function operation(id: string) {
  sessionStorage.setItem('demo-reel:operation', id);
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    const op = await api(`/operations/${id}`);
    if (op.status === 'succeeded') {
      if (sessionStorage.getItem('demo-reel:operation') === id)
        sessionStorage.removeItem('demo-reel:operation');
      return op;
    }
    if (op.status === 'failed') {
      if (sessionStorage.getItem('demo-reel:operation') === id)
        sessionStorage.removeItem('demo-reel:operation');
      throw new ApiError(op.error.code, op.error.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new ApiError(
    'OPERATION_TIMEOUT',
    '처리가 지연되고 있습니다. 새로고침하면 같은 작업을 이어서 확인합니다.',
  );
}
