import { readCursor, signCursor } from "./cursor";
import { renderBlocks } from "./content";
import { FeishuClient, type DocBlock } from "./feishu";

export type ToolContext = { user: string; client: string; token: string; cursorSecret: string; feishuBaseUrl: string; request?: typeof fetch };
const id = (value: string) => /^[A-Za-z0-9_-]{10,80}$/.test(value);
const fingerprint = async (value: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest.slice(0, 12))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function resource(input: string): { kind: "docx" | "wiki" | "doc"; token: string } {
  if (input.startsWith("https://")) {
    const url = new URL(input);
    if (!/(^|\.)feishu\.cn$/.test(url.hostname) || url.username || url.password) throw new Error("invalid_resource_url");
    const match = /^\/(docx|wiki|docs)\/([A-Za-z0-9_-]{10,80})\/?$/.exec(url.pathname);
    if (!match) throw new Error("unsupported_resource_url");
    return { kind: match[1] === "docs" ? "doc" : match[1] as "docx" | "wiki", token: match[2] };
  }
  const match = /^(docx|wiki|doc):([A-Za-z0-9_-]{10,80})$/.exec(input);
  if (!match) throw new Error("invalid_resource_id");
  return { kind: match[1] as "docx" | "wiki" | "doc", token: match[2] };
}

function sourceUrl(ctx: ToolContext, kind: "docx" | "wiki" | "doc", token: string): string {
  const base = new URL(ctx.feishuBaseUrl);
  if (base.protocol !== "https:" || !/(^|\.)feishu\.cn$/.test(base.hostname) || base.pathname !== "/") throw new Error("invalid_feishu_base_url");
  return new URL(`/${kind === "doc" ? "docs" : kind}/${token}`, base).toString();
}

export async function search(ctx: ToolContext, input: { query: string; kind?: "all" | "doc" | "wiki"; space_id?: string; cursor?: string }) {
  const query = input.query.trim();
  if (!query || query.length > 50) throw new Error("invalid_query");
  if (input.space_id && !id(input.space_id)) throw new Error("invalid_space_id");
  const kind = input.space_id ? "wiki" : input.kind ?? "all";
  const api = new FeishuClient(ctx.token, ctx.request ?? fetch);
  const items: { id: string; title: string; url: string; kind: string; readable: boolean; hit_source: string; resource_key: string }[] = [];
  let nextCursor: string | null = null;
  let limitReached = false;
  let allState = { d: 0, w: "", dd: false, wd: false, seen: [] as string[] };
  if (kind === "all" && input.cursor) {
    const decoded = await readCursor(ctx.cursorSecret, input.cursor, { kind: "search-all", user: ctx.user, client: ctx.client, resource: query });
    try {
      const state = JSON.parse(String(decoded.position)) as typeof allState;
      if (!Number.isSafeInteger(state.d) || state.d < 0 || typeof state.w !== "string" || typeof state.dd !== "boolean" || typeof state.wd !== "boolean" || !Array.isArray(state.seen) || state.seen.length > 400 || !state.seen.every((item) => typeof item === "string" && /^[\w-]{16}$/.test(item))) throw Error();
      allState = state;
    } catch { throw new Error("invalid_cursor"); }
  }
  if ((kind === "doc" || kind === "all") && (kind !== "all" || !allState.dd)) {
    const count = kind === "all" ? 10 : 20;
    const offset = kind === "all" ? allState.d : input.cursor ? Number((await readCursor(ctx.cursorSecret, input.cursor, { kind: "search-doc", user: ctx.user, client: ctx.client, resource: query })).position) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + count >= 200) throw new Error("search_limit_reached");
    const data = await api.searchDocs(query, offset, count);
    for (const item of data.docs_entities ?? []) {
      if (!id(item.docs_token)) continue;
      const docKind = item.docs_type === "docx" ? "docx" : "doc";
      items.push({ id: `${docKind}:${item.docs_token}`, title: item.title, url: sourceUrl(ctx, docKind, item.docs_token), kind: item.docs_type, readable: docKind === "docx", hit_source: "provider_keyword", resource_key: item.docs_token });
    }
    if (data.has_more) {
      if (offset + 2 * count >= 200) { limitReached = true; allState.dd = true; }
      else if (kind === "all") allState.d = offset + count;
      else nextCursor = await signCursor(ctx.cursorSecret, { kind: "search-doc", user: ctx.user, client: ctx.client, resource: query, position: offset + count });
    } else {
      allState.dd = true;
    }
  }
  if ((kind === "wiki" || kind === "all") && (kind !== "all" || !allState.wd)) {
    const page = kind === "all" ? allState.w || undefined : input.cursor ? String((await readCursor(ctx.cursorSecret, input.cursor, { kind: "search-wiki", user: ctx.user, client: ctx.client, resource: `${query}:${input.space_id ?? ""}` })).position) : undefined;
    const data = await api.searchWiki(query, input.space_id, page, kind === "all" ? 10 : 20);
    for (const item of data.items ?? []) {
      if (!id(item.node_id)) continue;
      items.push({ id: `wiki:${item.node_id}`, title: item.title, url: sourceUrl(ctx, "wiki", item.node_id), kind: "wiki", readable: item.obj_type === 8, hit_source: "provider_keyword", resource_key: item.obj_token });
    }
    if (data.has_more && !data.page_token) throw new Error("incomplete_search_page");
    if (data.has_more && data.page_token && kind === "wiki") nextCursor = await signCursor(ctx.cursorSecret, { kind: "search-wiki", user: ctx.user, client: ctx.client, resource: `${query}:${input.space_id ?? ""}`, position: data.page_token });
    if (kind === "all") { allState.w = data.page_token ?? ""; allState.wd = !data.has_more; }
  }
  const needsAllCursor = kind === "all" && (!allState.dd || !allState.wd);
  const unique = new Map<string, typeof items[number]>();
  for (const item of items) unique.set(item.resource_key, item.kind === "wiki" || !unique.has(item.resource_key) ? item : unique.get(item.resource_key)!);
  const visible: typeof items = [];
  for (const item of unique.values()) {
    const key = await fingerprint(item.resource_key);
    if (kind !== "all" || !allState.seen.includes(key)) visible.push(item);
    if (kind === "all") allState.seen.push(key);
  }
  if (kind === "all" && allState.seen.length >= 400) limitReached = true;
  else if (needsAllCursor) nextCursor = await signCursor(ctx.cursorSecret, { kind: "search-all", user: ctx.user, client: ctx.client, resource: query, position: JSON.stringify(allState) });
  return { items: visible.map(({ resource_key: _key, ...item }) => item), search_mode: "provider_keyword", next_cursor: nextCursor, limit_reached: limitReached, scope: input.space_id ? "wiki_space" : "visible_resources" };
}

export async function listWiki(ctx: ToolContext, input: { space_id?: string; node_id?: string; cursor?: string }) {
  if (input.node_id && !input.space_id) throw new Error("space_id_required");
  if (input.space_id && !id(input.space_id)) throw new Error("invalid_space_id");
  if (input.node_id && !id(input.node_id)) throw new Error("invalid_node_id");
  const target = `${input.space_id ?? ""}:${input.node_id ?? ""}`;
  const page = input.cursor ? String((await readCursor(ctx.cursorSecret, input.cursor, { kind: "wiki-list", user: ctx.user, client: ctx.client, resource: target })).position) : undefined;
  const api = new FeishuClient(ctx.token, ctx.request ?? fetch);
  if (!input.space_id) {
    const data = await api.listSpaces(page);
    return { items: data.items.map((item) => ({ id: item.space_id, title: item.name, kind: "space" })), next_cursor: data.has_more && data.page_token ? await signCursor(ctx.cursorSecret, { kind: "wiki-list", user: ctx.user, client: ctx.client, resource: target, position: data.page_token }) : null, scope: "visible_spaces" };
  }
  const data = await api.listNodes(input.space_id, input.node_id, page);
  return { items: data.items.map((item) => ({ id: `wiki:${item.node_token}`, title: item.title, kind: item.obj_type, readable: item.obj_type === "docx", has_child: !!item.has_child, url: sourceUrl(ctx, "wiki", item.node_token) })), next_cursor: data.has_more && data.page_token ? await signCursor(ctx.cursorSecret, { kind: "wiki-list", user: ctx.user, client: ctx.client, resource: target, position: data.page_token }) : null, scope: "one_level" };
}

export async function fetchDoc(ctx: ToolContext, input: { id: string; cursor?: string }) {
  const source = resource(input.id);
  const api = new FeishuClient(ctx.token, ctx.request ?? fetch);
  const node = source.kind === "wiki" ? (await api.getNode(source.token)).node : null;
  const kind = node?.obj_type ?? source.kind;
  const documentId = node?.obj_token ?? source.token;
  if (kind !== "docx") return { id: input.id, url: sourceUrl(ctx, source.kind, source.token), readable: false, error: "unsupported_type" };
  if (!id(documentId)) throw new Error("invalid_document_id");
  const before = (await api.getDoc(documentId)).document;
  const cursor = input.cursor ? await readCursor(ctx.cursorSecret, input.cursor, { kind: "fetch", user: ctx.user, client: ctx.client, resource: `${source.kind}:${source.token}` }) : null;
  if (cursor && cursor.revision !== before.revision_id) throw new Error("source_changed");
  const blocks: DocBlock[] = [];
  let page: string | undefined;
  do {
    const batch = await api.getBlocks(documentId, page);
    blocks.push(...batch.items);
    if (blocks.length > 2000) throw new Error("source_block_limit");
    page = batch.has_more ? batch.page_token : undefined;
    if (batch.has_more && !page) throw new Error("incomplete_document");
    if (blocks.length === 2000 && page) throw new Error("source_block_limit");
  } while (page);
  const after = (await api.getDoc(documentId)).document;
  if (before.revision_id !== after.revision_id) throw new Error("source_changed");
  const rendered = renderBlocks(blocks);
  const characters = Array.from(rendered.content);
  const position = cursor ? Number(cursor.position) : 0;
  if (!Number.isSafeInteger(position) || position < 0 || position > characters.length) throw new Error("invalid_cursor");
  const end = Math.min(position + 12_000, characters.length);
  const hasMore = end < characters.length;
  return { id: input.id, title: before.title, url: sourceUrl(ctx, source.kind, source.token), revision: before.revision_id, fetched_at: new Date().toISOString(), source_updated_at: null, content: characters.slice(position, end).join(""), has_more: hasMore, next_cursor: hasMore ? await signCursor(ctx.cursorSecret, { kind: "fetch", user: ctx.user, client: ctx.client, resource: `${source.kind}:${source.token}`, position: end, revision: before.revision_id }) : null, omissions: rendered.omissions };
}
