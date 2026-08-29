import { normalizePath, type DataAdapter } from "obsidian";

/** Local, best-effort diagnostics. Entries deliberately contain no credentials or protected settings. */
export class DebugLogger {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly pluginDirectory: string,
  ) {}

  async write(deviceId: string, message: string, details?: unknown): Promise<void> {
    const path = normalizePath(`${this.pluginDirectory}/logs/${deviceId}.log`);
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const directory = normalizePath(`${this.pluginDirectory}/logs`);
        if (!(await this.adapter.exists(directory))) await this.adapter.mkdir(directory);
        const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
        const line = `${new Date().toISOString()} ${message}${suffix}\n`;
        const existing = await this.adapter.exists(path) ? await this.adapter.read(path) : "";
        await this.adapter.write(path, `${existing}${line}`);
      } catch {
        // Diagnostics must never affect synchronization or settings saves.
      }
    });
    this.queues.set(deviceId, next);
    await next;
    if (this.queues.get(deviceId) === next) this.queues.delete(deviceId);
  }
}
