export type RequestReport = {
  event: "api_request";
  requestId: string;
  operation: string;
  method: string;
  status: number;
  timings: Record<string, number>;
};

export function operationOf(path: string, method: string) {
  if (path === "/api/search") return "search";
  if (path === "/api/docs") return method === "POST" ? "create" : "list";
  if (path.startsWith("/api/docs/")) return method === "PUT" ? "save" : "read";
  if (path.startsWith("/api/assets")) return method === "POST" ? "attach" : "asset";
  return "not-found";
}
export class RequestMetrics {
  readonly timings: Record<string, number> = {};
  private started: number;
  constructor(private clock = () => performance.now()) {
    this.started = clock();
  }
  async measure<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
    const start = this.clock();
    try {
      return await operation();
    } finally {
      this.timings[name] = (this.timings[name] ?? 0) + this.clock() - start;
    }
  }
  finish() {
    this.timings.total = this.clock() - this.started;
    return Object.entries(this.timings)
      .map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`)
      .join(", ");
  }
}
