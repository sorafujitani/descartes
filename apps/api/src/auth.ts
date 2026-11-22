import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./github.ts";

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authorize(req: Request, env: Env) {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_ISSUER) return false;
  try {
    const issuer = env.ACCESS_ISSUER.replace(/\/$/, "");
    if (!keysets.has(issuer)) {
      if (keysets.size >= 8) keysets.delete(keysets.keys().next().value!);
      keysets.set(issuer, createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs")));
    }
    await jwtVerify(token, keysets.get(issuer)!, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    return true;
  } catch {
    return false;
  }
}
