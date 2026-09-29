const API = "https://open.feishu.cn/open-apis";

export class FeishuError extends Error {
  constructor(public readonly code: string) { super(code); }
}

type Envelope<T> = { code?: number; data?: T };

export class FeishuClient {
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {}

  private async call<T>(path: string, body?: object): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new FeishuError("unsafe_api_path");
    const url = `${API}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(7_000),
        });
      } catch {
        if (attempt < 2) continue;
        throw new FeishuError("upstream_unavailable");
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) continue;
      if (response.status === 401) throw new FeishuError("needs_reauth");
      if (response.status === 403 || response.status === 404) throw new FeishuError("access_denied");
      if (!response.ok) throw new FeishuError("upstream_unavailable");
      let payload: Envelope<T>;
      try { payload = await response.json() as Envelope<T>; } catch { throw new FeishuError("invalid_upstream_response"); }
      if (payload.code !== 0) {
        if (payload.code === 99991679 || payload.code === 99991663) throw new FeishuError("missing_scope");
        throw new FeishuError("upstream_api_error");
      }
      if (payload.data === undefined) throw new FeishuError("invalid_upstream_response");
      return payload.data;
    }
    throw new FeishuError("upstream_unavailable");
  }

  searchDocs(query: string, offset: number, count = 20): Promise<{ docs_entities: { docs_token: string; docs_type: string; title: string }[]; has_more: boolean; total?: number }> {
    return this.call("/suite/docs-api/search/object", { search_key: query, count, offset });
  }

  searchWiki(query: string, spaceId?: string, pageToken?: string): Promise<{ items: WikiSearchItem[]; has_more: boolean; page_token?: string }> {
    const params = new URLSearchParams({ page_size: "20" });
    if (pageToken) params.set("page_token", pageToken);
    return this.call(`/wiki/v2/nodes/search?${params}`, { query, ...(spaceId ? { space_id: spaceId } : {}) });
  }

  listSpaces(pageToken?: string): Promise<{ items: { space_id: string; name: string }[]; has_more: boolean; page_token?: string }> {
    const params = new URLSearchParams({ page_size: "20" });
    if (pageToken) params.set("page_token", pageToken);
    return this.call(`/wiki/v2/spaces?${params}`);
  }

  listNodes(spaceId: string, parentNode?: string, pageToken?: string): Promise<{ items: WikiNode[]; has_more: boolean; page_token?: string }> {
    const params = new URLSearchParams({ page_size: "20" });
    if (parentNode) params.set("parent_node_token", parentNode);
    if (pageToken) params.set("page_token", pageToken);
    return this.call(`/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${params}`);
  }

  getNode(token: string): Promise<{ node: WikiNode }> {
    return this.call(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`);
  }

  getDoc(id: string): Promise<{ document: { title: string; revision_id: number } }> {
    return this.call(`/docx/v1/documents/${encodeURIComponent(id)}`);
  }

  getBlocks(id: string, pageToken?: string): Promise<{ items: DocBlock[]; has_more: boolean; page_token?: string }> {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    return this.call(`/docx/v1/documents/${encodeURIComponent(id)}/blocks?${params}`);
  }
}

export type WikiNode = { node_token: string; obj_token: string; obj_type: string; title: string; space_id?: string; has_child?: boolean };
export type WikiSearchItem = { node_id: string; obj_token: string; obj_type: number; title: string; url: string; space_id: string };
export type DocBlock = { block_id: string; block_type: number; parent_id?: string; children?: string[]; [key: string]: unknown };
