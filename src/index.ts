import OAuthProvider, { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { manage, readSession, sessionCookie, signedSession } from "./manage";
import { fetchDoc, listWiki, search } from "./tools";
import { FEISHU_SCOPES, allowed, authorizeUrl, challenge, exchangeCode, getIdentity, subject, verifier } from "./upstream";
import { UserVault, vaultFor, type Env } from "./vault";

export { UserVault };

const MCP_SCOPES = ["feishu.docs.read", "feishu.wiki.read"];
const safe = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
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
  const feishu = new URL(env.FEISHU_BASE_URL);
  if ((!local && (app.protocol !== "https:" || app.hostname.includes("example"))) || app.pathname !== "/" || app.search || app.hash || feishu.protocol !== "https:" || !/(^|\.)feishu\.cn$/.test(feishu.hostname) || (!local && feishu.hostname.startsWith("example.")) || feishu.pathname !== "/" || feishu.search || feishu.hash || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || env.CURSOR_SECRET.length < 32 || env.SESSION_SECRET.length < 32 || !env.VAULT_KEY || !env.ALLOWED_TENANTS || !env.ALLOWED_USERS || Object.values(env).some((value) => typeof value === "string" && value.startsWith("REPLACE_WITH"))) throw new Error("incomplete_configuration");
}

async function beginFeishu(oauth: OAuthHelpers, env: Env, request: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>, headers?: Headers) {
  const pkce = verifier();
  const upstream = await oauth.beginUpstream(request, { data: { verifier: pkce }, headers });
  upstream.headers.set("Location", authorizeUrl(env, `${env.APP_URL}callback`, FEISHU_SCOPES, upstream.state, await challenge(pkce)));
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function defaultHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER as OAuthHelpers;
  try {
    const managed = await manage(request, env, oauth);
    if (managed) return managed;
    if (url.pathname === "/authorize" && request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      const trusted = details.clientDomain ? `来源域名：${safe(details.clientDomain)}` : "客户端名称由其自行声明，尚未验证。";
      const scopes = details.scope.map((scope) => `<li>${safe(scope)}</li>`).join("");
      return html(`<h1>授权 Feishu Connect</h1><p>客户端：${safe(details.clientName)}</p><p>${trusted}</p><p>访问令牌将返回到：<strong>${safe(details.redirectHost)}</strong></p>${details.redirectIsLoopback ? "<p>这是本机回调地址，请确认你刚刚发起连接。</p>" : ""}<p>此连接可按你在飞书中的权限搜索并读取云文档、知识库原文；内容会发送给该 AI 产品。不会编辑飞书内容。</p><p>请求的权限：</p><ul>${scopes}</ul><form method="post" action="/authorize"><input type="hidden" name="handle" value="${safe(consent.handle)}"><p><button name="decision" value="approve">同意并登录飞书</button> <button name="decision" value="deny">拒绝</button></p></form>`, consent.headers);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
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
      const credentials = await exchangeCode(env, code, resumed.data.verifier, `${env.APP_URL}callback`);
      const user = await getIdentity(credentials.access);
      if (!allowed(env, user)) return html("<h1>当前飞书账号未受邀</h1>", resumed.headers);
      if (!credentials.refresh || !credentials.refreshExpires) throw new Error("feishu_offline_access_missing");
      const userId = await subject(env, user);
      const priorSession = await readSession(request, env);
      if (priorSession && priorSession.user !== userId) return html("<h1>飞书账号与本次浏览器中的原连接不一致</h1><p>请先断开原连接，再使用目标账号重新登录。</p>", resumed.headers);
      const vault = vaultFor(env, userId);
      const handle = crypto.randomUUID();
      await vault.savePending(handle, { credentials: { ...credentials, refresh: credentials.refresh, refreshExpires: credentials.refreshExpires }, identity: user, request: resumed.request, name: user.name ?? "Feishu user", expires: Date.now() + 10 * 60_000 });
      const session = { user: userId, name: user.name ?? "Feishu user", csrf: crypto.randomUUID(), pending: handle, expires: Date.now() + 30 * 60_000 };
      resumed.headers.append("Set-Cookie", sessionCookie(await signedSession(env, session)));
      return html(`<h1>确认飞书身份</h1><p>当前登录：${safe(session.name)}</p><p>企业标识：${safe(user.tenant_key)}</p><p>确认后，此 AI 客户端可按你的飞书权限读取云文档与知识库原文。</p><form method="post" action="/confirm"><input type="hidden" name="csrf" value="${safe(session.csrf)}"><button name="decision" value="approve">确认连接</button> <button name="decision" value="deny">取消</button></form>`, resumed.headers);
    }
    if (url.pathname === "/confirm" && request.method === "POST") {
      const session = await readSession(request, env);
      if (!session?.pending) return new Response("Login required", { status: 401 });
      if (request.headers.get("Origin") !== new URL(env.APP_URL).origin) return new Response("Invalid origin", { status: 403 });
      const form = await request.formData();
      if (form.get("csrf") !== session.csrf) return new Response("Invalid request", { status: 403 });
      const vault = vaultFor(env, session.user);
      const pending = await vault.consumePending(session.pending);
      if (!pending) return new Response("Confirmation expired", { status: 410 });
      if (form.get("decision") !== "approve") return Response.redirect(authorizationErrorRedirect(pending.request, "access_denied"), 302);
      const priorGrantIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await oauth.listUserGrants(session.user, { limit: 100, cursor });
        for (const grant of page.items) if (grant.clientId === pending.request.clientId && (!pending.request.clientId.startsWith("https://") || grant.redirectUri === pending.request.redirectUri)) priorGrantIds.push(grant.id);
        cursor = page.cursor;
      } while (cursor);
      if (!allowed(env, pending.identity)) return new Response("Account no longer allowed", { status: 403 });
      await vault.save({ ...pending.credentials, openId: pending.identity.open_id, tenantKey: pending.identity.tenant_key });
      const { redirectTo } = await oauth.completeAuthorization({ request: pending.request, userId: session.user, metadata: {}, scope: pending.request.scope.filter((scope) => MCP_SCOPES.includes(scope)), props: { userId: session.user, displayName: pending.name } });
      for (const id of priorGrantIds) await vault.blockGrant(id);
      const headers = new Headers({ Location: redirectTo });
      headers.append("Set-Cookie", sessionCookie(await signedSession(env, { ...session, pending: undefined })));
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === "/") return html(`<h1>Feishu Connect</h1><p>把你有权访问的飞书云文档和知识库原文，按需提供给支持远程 MCP 的 AI 助手。</p><p>只读、无全文索引。组织管理员需先配置应用与允许使用的成员。</p><p>远程 MCP 地址：<code>${safe(env.APP_URL)}mcp</code>。<a href="/connections">管理连接</a>。ChatGPT、Manus、Cue、Muse 的实际兼容性须分别验证。</p>`);
    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response("授权请求无效或已过期", { status: 400 });
    return new Response("服务暂时不可用", { status: 503 });
  }
}

async function mcpHandler(request: Request, env: Env, auth: { userId: string; clientId: string; grantId: string; scopes: string[] }): Promise<Response> {
  if (!MCP_SCOPES.every((scope) => auth.scopes.includes(scope))) return new Response("Insufficient scope", { status: 403 });
  const vault = vaultFor(env, auth.userId);
  if (await vault.isBlocked(auth.grantId)) return new Response("Connection revoked", { status: 401 });
  if (await vault.status() !== "connected") return new Response("Feishu reauthorization required", { status: 401 });
  const server = new McpServer({ name: "feishu-connect", version: "0.1.0" });
  const run = async (method: "search" | "fetch" | "list_wiki" | "connection_status", input: Record<string, unknown>) => {
    try {
      if (method === "connection_status") return { content: [{ type: "text" as const, text: JSON.stringify({ state: await vault.status(), user: auth.userId.slice(0, 12), capabilities: ["docx", "wiki"], scopes: auth.scopes, last_success_at: auth.clientId ? await vault.lastUsed(auth.clientId) : null }) }] };
      const token = await vault.accessToken();
      const ctx = { user: auth.userId, client: auth.clientId, token, cursorSecret: env.CURSOR_SECRET, feishuBaseUrl: env.FEISHU_BASE_URL };
      const result = method === "search" ? await search(ctx, input as Parameters<typeof search>[1]) : method === "fetch" ? await fetchDoc(ctx, input as Parameters<typeof fetchDoc>[1]) : await listWiki(ctx, input as Parameters<typeof listWiki>[1]);
      await vault.markUsed(auth.clientId);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal_error";
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: /^[a-z_]+$/.test(code) ? code : "internal_error", request_id: crypto.randomUUID() }) }] };
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
    apiHandler: { fetch: async (request, runtime, ctx) => {
      const verified = ctx as ExecutionContext & { props: { userId: string }; auth: { token: string; clientId?: string; scope: string[] } };
      const record = await (runtime.OAUTH_PROVIDER as OAuthHelpers).unwrapToken(verified.auth.token);
      if (!record || record.userId !== verified.props.userId || !verified.auth.clientId) return new Response("Invalid grant", { status: 401 });
      return mcpHandler(request, runtime, { userId: verified.props.userId, clientId: verified.auth.clientId, grantId: record.grantId, scopes: verified.auth.scope });
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
