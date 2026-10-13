export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

// Only retry operations whose server contract is read-only or idempotent.
// Preserve the exact body/request ID across attempts (including lost responses).
export function createApi({ fetchImpl = fetch, timeoutMs = 15000, retryDelays = [250, 750],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async function api(path, body) {
    const url = new URL(path, 'http://localhost'), name = url.pathname;
    const safeGet = body === undefined && (name !== '/api/feed' || !!url.searchParams.get('requestId'));
    const retryable = safeGet || name === '/api/close' ||
      (['/api/event', '/api/followup'].includes(name) && !!body?.eventId) ||
      (name === '/api/swap' && !!body?.requestId);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let error;
      try {
        const r = await fetchImpl(path, { method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: serialized, signal: controller.signal });
        let value;
        try { value = await r.json(); }
        catch { throw new ApiError('服务器返回了无效响应', r.status); }
        if (!r.ok) throw new ApiError(value.error || '请求失败', r.status);
        return value;
      } catch (caught) {
        error = caught instanceof ApiError ? caught : new ApiError(controller.signal.aborted ? '请求超时，请重试' : '网络连接失败，请重试');
      } finally { clearTimeout(timer); }
      if (!retryable || attempt >= retryDelays.length || (error.status !== 0 && ![502, 503, 504].includes(error.status))) throw error;
      await sleep(retryDelays[attempt]);
    }
  };
}

// Serializes page mutations without queuing stale clicks. Per-operation UI
// changes (e.g. a successful like remaining disabled) stay with their caller.
export function createActionGate({ onBusy = () => {}, onError = () => {} } = {}) {
  let busy = false;
  return async work => {
    if (busy) return false;
    busy = true; onBusy(true);
    try { await work(); return true; }
    catch (error) { onError(error); return false; }
    finally { busy = false; onBusy(false); }
  };
}
