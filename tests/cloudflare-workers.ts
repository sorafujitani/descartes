// Node stand-in for the workerd module so Worker code can be unit-tested.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
