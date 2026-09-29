import type { Env } from "./vault";

export const FEISHU_SCOPES = "search:docs:read docx:document:readonly wiki:wiki:readonly offline_access";
const base64url = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function verifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
}

export async function challenge(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function authorizeUrl(env: Env, redirect: string, scope: string, state: string, pkce: string): string {
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("client_id", env.FEISHU_APP_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect);
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", pkce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(env: Env, code: string, pkce: string, redirect: string): Promise<{ access: string; refresh?: string; accessExpires: number; refreshExpires?: number }> {
  const response = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(7_000),
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: pkce, client_id: env.FEISHU_APP_ID, client_secret: env.FEISHU_APP_SECRET, redirect_uri: redirect }),
  });
  if (!response.ok) throw new Error("feishu_token_exchange_failed");
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") throw new Error("feishu_token_response_invalid");
  return { access: data.access_token, refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined, accessExpires: Date.now() + data.expires_in * 1000, refreshExpires: typeof data.refresh_token_expires_in === "number" ? Date.now() + data.refresh_token_expires_in * 1000 : undefined };
}

export async function getIdentity(access: string): Promise<{ open_id: string; tenant_key: string; name?: string }> {
  const response = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { Authorization: `Bearer ${access}` }, redirect: "error", signal: AbortSignal.timeout(7_000) });
  if (!response.ok) throw new Error("feishu_identity_failed");
  const body = await response.json() as { code?: number; data?: { open_id?: string; tenant_key?: string; name?: string } };
  if (body.code !== 0 || !body.data?.open_id || !body.data?.tenant_key) throw new Error("feishu_identity_invalid");
  return { open_id: body.data.open_id, tenant_key: body.data.tenant_key, name: body.data.name };
}

export function allowed(env: Env, user: { open_id: string; tenant_key: string }): boolean {
  return env.ALLOWED_TENANTS.split(",").map((x) => x.trim()).includes(user.tenant_key) && env.ALLOWED_USERS.split(",").map((x) => x.trim()).includes(user.open_id);
}

export async function subject(env: Env, user: { open_id: string; tenant_key: string }): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.FEISHU_APP_ID}\0${user.tenant_key}\0${user.open_id}`));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
