import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { allowed, authorizeUrl, challenge, exchangeCode, getIdentity, subject, verifier } from "./upstream";
import { vaultFor, type Env } from "./vault";

export type Session = { user: string; name: string; csrf: string; expires: number; pending?: string };
const encoder = new TextEncoder();
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value: string) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export const sessionCookie = (value: string) => cookie("__Host-feishu-connect-session", value, 1800);
const cookieValue = (request: Request, name: string) => request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const signingKey = (secret: string) => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signedSession(env: Env, session: Session): Promise<string> {
  const body = b64(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env.SESSION_SECRET), encoder.encode(body));
  return `${body}.${b64(new Uint8Array(signature))}`;
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  try {
    const value = cookieValue(request, "__Host-feishu-connect-session");
    if (!value || value.length > 2048) return null;
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra || !await crypto.subtle.verify("HMAC", await signingKey(env.SESSION_SECRET), unb64(signature), encoder.encode(body))) return null;
    const session = JSON.parse(new TextDecoder().decode(unb64(body))) as Session;
    return session.user && session.csrf && session.expires > Date.now() ? session : null;
  } catch { return null; }
}

function page(body: string): Response {
  return new Response(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Manage Feishu Connect</title><style>body{font:16px system-ui;max-width:44rem;margin:4rem auto;padding:1rem;line-height:1.6}button{padding:.5rem}</style>${body}</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'", "X-Frame-Options": "DENY" } });
}

async function allGrants(oauth: OAuthHelpers, user: string) {
  const output: Awaited<ReturnType<OAuthHelpers["listUserGrants"]>>["items"] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(user, { limit: 100, cursor });
    output.push(...page.items);
    cursor = page.cursor;
    if (output.length > 100 || (cursor && output.length === 0)) throw new Error("connection_list_limit");
  } while (cursor);
  return output;
}

export async function manage(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/manage/login" && request.method === "GET") {
    const state = random();
    const binding = random();
    const pkce = verifier();
    await env.OAUTH_KV.put(`manage:${await hash(state)}`, JSON.stringify({ binding: await hash(binding), pkce }), { expirationTtl: 600 });
    const headers = new Headers({ Location: authorizeUrl(env, `${env.APP_URL}manage/callback`, "", state, await challenge(pkce)) });
    headers.append("Set-Cookie", cookie("__Host-feishu-connect-state", binding, 600));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === "/manage/callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    const binding = cookieValue(request, "__Host-feishu-connect-state");
    if (!state || !binding) return page("<h1>登录已过期</h1>");
    const key = `manage:${await hash(state)}`;
    const record = await env.OAUTH_KV.get(key, "json") as { binding?: string; pkce?: string } | null;
    if (!record?.pkce || record.binding !== await hash(binding)) return page("<h1>登录已过期</h1>");
    await env.OAUTH_KV.delete(key);
    if (url.searchParams.get("error")) return page("<h1>已取消飞书登录</h1>");
    const code = url.searchParams.get("code");
    if (!code) return page("<h1>登录失败</h1>");
    const credentials = await exchangeCode(env, code, record.pkce, `${env.APP_URL}manage/callback`);
    const user = await getIdentity(credentials.access);
    if (!allowed(env, user)) return page("<h1>当前飞书账号未受邀</h1>");
    const session = await signedSession(env, { user: await subject(env, user), name: user.name ?? "Feishu user", csrf: random(), expires: Date.now() + 30 * 60_000 });
    const headers = new Headers({ Location: `${env.APP_URL}connections` });
    headers.append("Set-Cookie", sessionCookie(session));
    headers.append("Set-Cookie", cookie("__Host-feishu-connect-state", "", 0));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === "/connections" && request.method === "GET") {
    const session = await readSession(request, env);
    if (!session) return Response.redirect(`${env.APP_URL}manage/login`, 302);
    const grants = await allGrants(oauth, session.user);
    const vault = vaultFor(env, session.user);
    const rows = await Promise.all(grants.map(async (grant) => {
      const client = await oauth.lookupClient(grant.clientId);
      const name = client?.clientName ?? "Unknown client";
      const lastUsed = await vault.lastUsed(grant.clientId);
      let callbackHost = "unknown";
      try { if (grant.redirectUri) callbackHost = new URL(grant.redirectUri).host; } catch { /* display only */ }
      return `<li><strong>${escape(name)}</strong>（客户端自行声明的名称） — 回调域：${escape(callbackHost)} — ${escape(grant.scope.join(", "))} — 最近成功读取：${lastUsed ? new Date(lastUsed).toISOString() : "尚无"}<form method="post" action="/connections/revoke"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="grant" value="${escape(grant.id)}"><button>断开此连接</button></form></li>`;
    }));
    const status = await vaultFor(env, session.user).status();
    return page(`<h1>Feishu Connect 连接</h1><p>飞书身份：${escape(session.name)}；状态：${escape(status)}</p><ul>${rows.join("") || "<li>没有活跃连接</li>"}</ul><form method="post" action="/connections/revoke"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="grant" value="all"><button>断开全部并删除飞书凭据</button></form><p>已返回给 AI 产品的内容和聊天历史无法从这里撤回。</p>`);
  }
  if (url.pathname === "/connections/revoke" && request.method === "POST") {
    const session = await readSession(request, env);
    if (!session) return new Response("Authentication required", { status: 401 });
    if (request.headers.get("Origin") !== new URL(env.APP_URL).origin) return new Response("Invalid origin", { status: 403 });
    const form = await request.formData();
    if (form.get("csrf") !== session.csrf) return new Response("Invalid request", { status: 403 });
    const selected = String(form.get("grant") ?? "");
    const grants = await allGrants(oauth, session.user);
    const targets = selected === "all" ? grants : grants.filter((grant) => grant.id === selected);
    if (!targets.length && selected !== "all") return new Response("Connection not found", { status: 404 });
    const vault = vaultFor(env, session.user);
    for (const grant of targets) {
      await vault.blockGrant(grant.id);
      await oauth.revokeGrant(grant.id, session.user);
    }
    if (selected === "all" || grants.length === targets.length) await vaultFor(env, session.user).clear();
    return Response.redirect(`${env.APP_URL}connections`, 303);
  }
  return null;
}
