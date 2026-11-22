/** Bounded, memory-only render cache. No notebook content is persisted in browser storage. */
export class MarkdownRenderer {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (html: string) => void; reject: (error: Error) => void }
  >();
  private inFlight = new Map<string, Promise<string>>();
  private cache = new Map<string, string>();
  private bytes = 0;
  constructor(
    private createWorker: () => Worker,
    private budget = 4 * 1024 * 1024,
  ) {}

  render(source: string): Promise<string> {
    const cached = this.cache.get(source);
    if (cached !== undefined) {
      this.cache.delete(source);
      this.cache.set(source, cached);
      return Promise.resolve(cached);
    }
    const running = this.inFlight.get(source);
    if (running) return running;
    const promise = this.request(source)
      .then((html) => {
        const size = (source.length + html.length) * 2;
        if (size <= this.budget) {
          while (this.bytes + size > this.budget || this.cache.size >= 8) {
            const oldest = this.cache.keys().next().value!;
            this.bytes -= (oldest.length + this.cache.get(oldest)!.length) * 2;
            this.cache.delete(oldest);
          }
          this.cache.set(source, html);
          this.bytes += size;
        }
        return html;
      })
      .finally(() => {
        this.inFlight.delete(source);
      });
    this.inFlight.set(source, promise);
    return promise;
  }
  private request(source: string) {
    return new Promise<string>((resolve, reject) => {
      try {
        if (!this.worker) {
          const worker = this.createWorker();
          this.worker = worker;
          worker.addEventListener(
            "message",
            (event: MessageEvent<{ id: number; html?: string; error?: string }>) => {
              const pending = this.pending.get(event.data.id);
              if (!pending) return;
              this.pending.delete(event.data.id);
              if (typeof event.data.html === "string") pending.resolve(event.data.html);
              else pending.reject(new Error(event.data.error || "Markdown rendering failed."));
            },
          );
          const failed = () => {
            if (this.worker !== worker) return;
            worker.terminate();
            this.worker = undefined;
            for (const pending of this.pending.values())
              pending.reject(new Error("Markdown worker failed."));
            this.pending.clear();
          };
          worker.addEventListener("error", failed);
          worker.addEventListener("messageerror", failed);
        }
        const id = ++this.sequence;
        this.pending.set(id, { resolve, reject });
        try {
          this.worker.postMessage({ id, source });
        } catch (error) {
          this.pending.delete(id);
          throw error;
        }
      } catch (error) {
        reject(error);
      }
    });
  }
}
export const renderer = new MarkdownRenderer(
  () => new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" }),
);
