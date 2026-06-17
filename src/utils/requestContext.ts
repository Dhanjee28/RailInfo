import { AsyncLocalStorage } from 'async_hooks';

// Per-request context propagated implicitly through the async call chain.
// A middleware seeds it once per request; the logger reads requestId out of it
// so every log line emitted while handling that request is correlated — without
// threading requestId through every function signature.
type Store = { requestId: string };

const storage = new AsyncLocalStorage<Store>();

export function runWithContext<T>(ctx: Store, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
