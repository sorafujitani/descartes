import { createApi } from "../apps/api/src/routes.ts";
import type { Repository } from "../apps/api/src/repository.ts";

// Exercise the real HTTP middleware with an explicit test-only storage resolver.
const app = createApi<Repository>((_req, store) => store);
export const route = (req: Request, store: Repository) => app.fetch(req, store);
