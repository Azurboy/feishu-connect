import OAuthProvider, { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { fetchDoc, listWiki, search } from "./tools";
import { UserVault, vaultFor, type Env } from "./vault";

export { UserVault };

const FEISHU_SCOPES = "search:docs:read docx:document:readonly wiki:wiki:readonly offline_access";
const MCP_SCOPES = ["feishu.docs.read", "feishu.wiki.read"];
const safe = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const html = (body: string, headers?: Headers) => {
  const out = new Headers(headers);
  out.set("Content-Type", "text/html; charset=utf-8");
  out.set("Cache-Control", "no-store");
  out.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'");
  out.set("X-Frame-Options", "DENY");
  return new Response(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Feishu Connect</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem;line-height:1.6}button{padding:.6rem 1rem}</style>${body}</html>`, { headers: out });
};

function checkConfig(env: Env): void {
  const app = new URL(env.APP_URL);
  const local = app.protocol === "http:" && ["localhost", "127.0.0.1"].includes(app.hostname);
  if ((!local && app.protocol !== "https:") || app.pathname !== "/" || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.CURSOR_SECRET || !env.VAULT_KEY || !env.ALLOWED_TENANTS || !env.ALLOWED_USERS || Object.values(env).some((value) => typeof value === "string" && value.startsWith("REPLACE_WITH"))) throw new Error("incomplete_configuration");
}

async function tokenExchange(env: Env, code: string, verifier: string) {
  const response = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(7_000),
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: env.FEISHU_APP_ID, client_secret: env.FEISHU_APP_SECRET, redirect_uri: `${env.APP_URL}callback` }),
  });
  if (!response.ok) throw new Error("feishu_token_exchange_failed");
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number" || typeof data.refresh_token_expires_in !== "number") throw new Error("feishu_token_response_invalid");
  return { access: data.access_token, refresh: data.refresh_token, accessExpires: Date.now() + data.expires_in * 1000, refreshExpires: Date.now() + data.refresh_token_expires_in * 1000 };
}

async function identity(access: string) {
  const response = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { Authorization: `Bearer ${access}` }, redirect: "error", signal: AbortSignal.timeout(7_000) });
  if (!response.ok) throw new Error("feishu_identity_failed");
  const body = await response.json() as { code?: number; data?: { open_id?: string; tenant_key?: string; name?: string } };
  if (body.code !== 0 || !body.data?.open_id || !body.data?.tenant_key) throw new Error("feishu_identity_invalid");
  return body.data;
}

async function beginFeishu(oauth: OAuthHelpers, env: Env, request: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>, headers?: Headers) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const upstream = await oauth.beginUpstream(request, { data: { verifier }, headers });
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("client_id", env.FEISHU_APP_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${env.APP_URL}callback`);
  url.searchParams.set("scope", FEISHU_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", upstream.state);
  upstream.headers.set("Location", url.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function defaultHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER as OAuthHelpers;
  try {
    if (url.pathname === "/authorize" && request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      const trusted = details.clientDomain ? `来源域名：${safe(details.clientDomain)}` : "客户端名称由其自行声明，尚未验证。";
      const scopes = details.scope.map((scope) => `<label><input type="checkbox" name="scope" value="${safe(scope)}" checked> ${safe(scope)}</label>`).join("<br>");
      return html(`<h1>授权 Feishu Connect</h1><p>客户端：${safe(details.clientName)}</p><p>${trusted}</p><p>访问令牌将返回到：<strong>${safe(details.redirectHost)}</strong></p>${details.redirectIsLoopback ? "<p>这是本机回调地址，请确认你刚刚发起连接。</p>" : ""}<p>此连接可按你在飞书中的权限搜索并读取云文档、知识库原文；内容会发送给该 AI 产品。不会编辑飞书内容。</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${safe(consent.handle)}">${scopes}<p><button name="decision" value="approve">同意并登录飞书</button> <button name="decision" value="deny">拒绝</button></p></form>`, consent.headers);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
      return beginFeishu(oauth, env, approved.request, approved.headers);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      const resumed = await oauth.finishUpstream<{ verifier: string }>(request);
      if (url.searchParams.get("error")) {
        resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      const code = url.searchParams.get("code");
      if (!code || !resumed.data?.verifier) throw new Error("feishu_callback_invalid");
      const credentials = await tokenExchange(env, code, resumed.data.verifier);
      const user = await identity(credentials.access);
      const tenants = new Set(env.ALLOWED_TENANTS.split(",").map((x) => x.trim()));
      const users = new Set(env.ALLOWED_USERS.split(",").map((x) => x.trim()));
      if (!tenants.has(user.tenant_key!) || !users.has(user.open_id!)) return html("<h1>当前飞书账号未受邀</h1>", resumed.headers);
      const userId = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.FEISHU_APP_ID}\0${user.tenant_key}\0${user.open_id}`)));
      await vaultFor(env, userId).save(credentials);
      const { redirectTo } = await oauth.completeAuthorization({ request: resumed.request, userId, metadata: {}, scope: resumed.request.scope.filter((scope) => MCP_SCOPES.includes(scope)), props: { userId, tenant: user.tenant_key, openId: user.open_id, displayName: user.name ?? "Feishu user" } });
      resumed.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: resumed.headers });
    }
    if (url.pathname === "/") return html("<h1>Feishu Connect</h1><p>把你有权访问的飞书云文档和知识库原文，按需提供给支持远程 MCP 的 AI 助手。</p><p>只读、无全文索引。组织管理员需先配置应用与允许使用的成员。</p><p>远程 MCP 地址：<code>/mcp</code>。当前只记录通用协议实现；ChatGPT、Manus、Cue、Muse 的实际兼容性须分别验证。</p>");
    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response("授权请求无效或已过期", { status: 400 });
    return new Response("服务暂时不可用", { status: 503 });
  }
}

async function mcpHandler(request: Request, env: Env, auth: { userId: string; clientId: string; scopes: string[] }): Promise<Response> {
  if (!MCP_SCOPES.every((scope) => auth.scopes.includes(scope))) return new Response("Insufficient scope", { status: 403 });
  const vault = vaultFor(env, auth.userId);
  if (await vault.status() !== "connected") return new Response("Feishu reauthorization required", { status: 401 });
  const server = new McpServer({ name: "feishu-connect", version: "0.1.0" });
  const run = async (method: "search" | "fetch" | "list_wiki" | "connection_status", input: Record<string, unknown>) => {
    try {
      if (method === "connection_status") return { content: [{ type: "text" as const, text: JSON.stringify({ state: await vault.status(), user: auth.userId.slice(0, 12), capabilities: ["docx", "wiki"], scopes: auth.scopes }) }] };
      const token = await vault.accessToken();
      const ctx = { user: auth.userId, client: auth.clientId, token, cursorSecret: env.CURSOR_SECRET, feishuBaseUrl: env.FEISHU_BASE_URL };
      const result = method === "search" ? await search(ctx, input as Parameters<typeof search>[1]) : method === "fetch" ? await fetchDoc(ctx, input as Parameters<typeof fetchDoc>[1]) : await listWiki(ctx, input as Parameters<typeof listWiki>[1]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal_error";
      return { isError: true, content: [{ type: "text" as const, text: /^[a-z_]+$/.test(code) ? code : "internal_error" }] };
    }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("search", { title: "Search Feishu", description: "Search visible Feishu documents and Wiki titles by keyword. Results are not document content.", inputSchema: { query: z.string(), kind: z.enum(["all", "doc", "wiki"]).optional(), space_id: z.string().optional(), cursor: z.string().optional() }, annotations }, (input) => run("search", input));
  server.registerTool("fetch", { title: "Read Feishu Docx", description: "Read original Docx text or a Wiki Docx page, with source and revision. Unsupported media is marked as omitted.", inputSchema: { id: z.string(), cursor: z.string().optional() }, annotations }, (input) => run("fetch", input));
  server.registerTool("list_wiki", { title: "List Feishu Wiki", description: "List visible Wiki spaces or one level of nodes; continue with cursor for more.", inputSchema: { space_id: z.string().optional(), node_id: z.string().optional(), cursor: z.string().optional() }, annotations }, (input) => run("list_wiki", input));
  server.registerTool("connection_status", { title: "Connection status", description: "Show Feishu connection state and read capabilities, without secrets.", inputSchema: {}, annotations }, () => run("connection_status", {}));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function provider(env: Env) {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: (request, runtime, ctx) => {
      const verified = ctx as ExecutionContext & { props: { userId: string }; auth: { clientId?: string; scope: string[] } };
      return mcpHandler(request, runtime, { userId: verified.props.userId, clientId: verified.auth.clientId ?? "", scopes: verified.auth.scope });
    } },
    defaultHandler: { fetch: defaultHandler },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: MCP_SCOPES,
    requiredScopes: MCP_SCOPES,
    resourceMetadata: { resource: `${env.APP_URL}mcp`, authorization_servers: [env.APP_URL.slice(0, -1)], resource_name: "Feishu Connect" },
    accessTokenTTL: 900,
    refreshTokenTTL: 7 * 24 * 3600,
    refreshTokenIdleTTL: 7 * 24 * 3600,
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    checkConfig(env);
    return provider(env).fetch(request, env, ctx);
  },
};
