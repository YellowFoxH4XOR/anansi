// Mutation state: which mutation is currently live on the storefront.
//
// The Lab runs as ONE always-on container (see Dockerfile), so a process-local
// Map is the whole story — every request hits the same process, a fire on
// /__control is visible to the next page load immediately, and a restart resets
// to baseline "none", which is the safe state. No external store required.
//
// It is injected rather than module-global so each test gets a clean instance.
// The rule that still matters: state is read on EVERY request, never cached at
// module load — see app.ts.

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class MemoryKv implements Kv {
  private m = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
}
