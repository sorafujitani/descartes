// Only the runtime surface this Worker uses; workerd provides the implementation.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
