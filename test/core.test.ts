import { describe, expect, it, vi } from "vitest";
const vaultMock = vi.hoisted(() => ({ blockGrant: vi.fn(), clear: vi.fn(), status: vi.fn(), lastUsed: vi.fn() }));
vi.mock("../src/vault", () => ({ vaultFor: () => vaultMock }));
import { readCursor, signCursor } from "../src/cursor";
import { renderBlocks } from "../src/content";
import { FeishuClient } from "../src/feishu";
import { fetchDoc, search, type ToolContext } from "../src/tools";
import { signedSession, readSession, manage } from "../src/manage";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../src/vault";

const SECRET = "unit-test-cursor-key-with-more-than-32-characters";

describe("signed cursors", () => {
  it("binds a page to the user, client, resource, and kind", async () => {
    const value = { kind: "fetch" as const, user: "alice", client: "chatgpt", resource: "docx:abc", position: 12, revision: 3 };
    const signed = await signCursor(SECRET, value);
    expect((await readCursor(SECRET, signed, value)).position).toBe(12);
    await expect(readCursor(SECRET, signed, { ...value, user: "bob" })).rejects.toThrow("invalid_cursor");
    await expect(readCursor(SECRET, signed, { ...value, client: "muse" })).rejects.toThrow("invalid_cursor");
    await expect(readCursor(SECRET, signed, { ...value, resource: "docx:other" })).rejects.toThrow("invalid_cursor");
    await expect(readCursor(SECRET, signed, { ...value, kind: "wiki-list" })).rejects.toThrow("invalid_cursor");
    await expect(readCursor(SECRET, signed.slice(0, -2) + "ab", value)).rejects.toThrow("invalid_cursor");
  });
});

describe("management session", () => {
  it("accepts only a signed, unexpired browser cookie", async () => {
    const env = { SESSION_SECRET: "synthetic-session-secret-at-least-32-characters" } as Env;
    const session = { user: "alice", name: "Alice", csrf: "csrf-synthetic", expires: Date.now() + 60_000 };
    const value = await signedSession(env, session);
    const request = (cookie: string) => new Request("https://bridge.example/connections", { headers: { Cookie: `__Host-feishu-connect-session=${cookie}` } });
    expect((await readSession(request(value), env))?.user).toBe("alice");
    expect(await readSession(request(value.slice(0, -2) + "ab"), env)).toBeNull();
    const expired = await signedSession(env, { ...session, expires: Date.now() - 1 });
    expect(await readSession(request(expired), env)).toBeNull();
  });

  it("rejects revoke requests without a valid session and same-origin form", async () => {
    const env = { SESSION_SECRET: "synthetic-session-secret-at-least-32-characters", APP_URL: "https://bridge.example/" } as Env;
    const oauth = { revokeGrant: vi.fn() } as unknown as OAuthHelpers;
    const anonymous = new Request("https://bridge.example/connections/revoke", { method: "POST" });
    expect((await manage(anonymous, env, oauth))?.status).toBe(401);
    const value = await signedSession(env, { user: "alice", name: "Alice", csrf: "csrf-synthetic", expires: Date.now() + 60_000 });
    const wrongOrigin = new Request("https://bridge.example/connections/revoke", { method: "POST", headers: { Cookie: `__Host-feishu-connect-session=${value}`, Origin: "https://evil.example" } });
    expect((await manage(wrongOrigin, env, oauth))?.status).toBe(403);
    expect(oauth.revokeGrant).not.toHaveBeenCalled();
  });

  it("revokes only a grant owned by the signed-in user and blocks it first", async () => {
    const env = { SESSION_SECRET: "synthetic-session-secret-at-least-32-characters", APP_URL: "https://bridge.example/" } as Env;
    const cookie = await signedSession(env, { user: "alice", name: "Alice", csrf: "csrf-synthetic", expires: Date.now() + 60_000 });
    const events: string[] = [];
    vaultMock.blockGrant.mockImplementation(async (grant: string) => { events.push(`block:${grant}`); });
    vaultMock.clear.mockReset();
    const oauth = {
      listUserGrants: vi.fn(async (user: string) => { expect(user).toBe("alice"); return { items: [{ id: "alice-grant", clientId: "client-a" }], cursor: undefined }; }),
      revokeGrant: vi.fn(async (grant: string, user: string) => { events.push(`revoke:${grant}:${user}`); }),
    } as unknown as OAuthHelpers;
    const request = (grant: string) => new Request("https://bridge.example/connections/revoke", {
      method: "POST",
      headers: { Cookie: `__Host-feishu-connect-session=${cookie}`, Origin: "https://bridge.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "csrf-synthetic", grant }),
    });
    expect((await manage(request("bob-grant"), env, oauth))?.status).toBe(404);
    expect(events).toEqual([]);
    expect((await manage(request("alice-grant"), env, oauth))?.status).toBe(303);
    expect(events).toEqual(["block:alice-grant", "revoke:alice-grant:alice"]);
    expect(vaultMock.clear).toHaveBeenCalledOnce();
  });
});

describe("Docx original text", () => {
  it("follows the original child order and marks unsupported media", () => {
    const result = renderBlocks([
      { block_id: "root", block_type: 1, children: ["head", "para", "img"] },
      { block_id: "img", block_type: 27, parent_id: "root" },
      { block_id: "para", block_type: 2, parent_id: "root", text: { elements: [{ text_run: { content: "中文😀" } }] } },
      { block_id: "head", block_type: 3, parent_id: "root", heading1: { elements: [{ text_run: { content: "标题" } }] } },
    ]);
    expect(result.content).toBe("# 标题\n\n中文😀\n\n[image 未读取]");
    expect(result.omissions).toEqual([{ type: "image", reason: "not_supported_in_v0.1" }]);
  });

  it("fails on missing blocks instead of returning a plausible partial document", () => {
    expect(() => renderBlocks([{ block_id: "root", block_type: 1, children: ["missing"] }])).toThrow("incomplete_document_tree");
  });

  it("marks unknown blocks and inline elements as unread", () => {
    const result = renderBlocks([
      { block_id: "root", block_type: 1, children: ["text", "unknown"] },
      { block_id: "text", block_type: 2, parent_id: "root", text: { elements: [{ equation: { content: "x" } }] } },
      { block_id: "unknown", block_type: 901, parent_id: "root" },
    ]);
    expect(result.content).toContain("[inline_element 未读取]");
    expect(result.content).toContain("[block_901 未读取]");
    expect(result.omissions.map((item) => item.type)).toEqual(["inline_element", "block_901"]);
  });

  it("renders a plain text table in row order", () => {
    const blocks = [
      { block_id: "root", block_type: 1, children: ["table"] },
      { block_id: "table", block_type: 31, parent_id: "root", table: { property: { row_size: 2, column_size: 2 }, cells: ["a", "b", "c", "d"] } },
      ...["a", "b", "c", "d"].map((block_id, index) => ({ block_id, block_type: 32, parent_id: "table", children: [`${block_id}-text`], table_cell: {}, index })),
      ...["a", "b", "c", "d"].map((item) => ({ block_id: `${item}-text`, block_type: 2, parent_id: item, text: { elements: [{ text_run: { content: item.toUpperCase() } }] } })),
    ];
    expect(renderBlocks(blocks).content).toBe("| A | B |\n| --- | --- |\n| C | D |");
  });
});

describe("Feishu fixed API", () => {
  it("uses only the official endpoint and rejects a business error", async () => {
    const calls: string[] = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token" });
      return Response.json({ code: 99991679, msg: "permission denied" });
    };
    const api = new FeishuClient("synthetic-token", request as typeof fetch);
    await expect(api.getDoc("doxcnSynthetic1234567890123")).rejects.toThrow("missing_scope");
    expect(calls).toEqual(["https://open.feishu.cn/open-apis/docx/v1/documents/doxcnSynthetic1234567890123"]);
  });

  it("stops before an upstream request when the tool budget has expired", async () => {
    const request = vi.fn();
    const api = new FeishuClient("synthetic-token", request as typeof fetch, Date.now() - 1);
    await expect(api.getDoc("doxcnSynthetic1234567890123")).rejects.toThrow("upstream_unavailable");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("read-only tools", () => {
  const context = (request: typeof fetch): ToolContext => ({ user: "alice", client: "client-a", token: "synthetic-token", cursorSecret: SECRET, feishuBaseUrl: "https://example.feishu.cn/", request });

  it("deduplicates Docx and Wiki hits by underlying resource", async () => {
    const request = async (url: string | URL | Request) => {
      if (String(url).includes("/search/object")) return Response.json({ code: 0, data: { docs_entities: [{ docs_token: "doxcnSynthetic1234567890123", docs_type: "docx", title: "Doc" }], has_more: false } });
      if (String(url).includes("/nodes/search")) return Response.json({ code: 0, data: { items: [{ node_id: "wikcnSynthetic1234567890123", obj_token: "doxcnSynthetic1234567890123", obj_type: 8, title: "Wiki", url: "https://example.feishu.cn/wiki/wikcnSynthetic1234567890123" }], has_more: false } });
      throw Error("unexpected_request");
    };
    const result = await search(context(request as typeof fetch), { query: "test" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("wiki:wikcnSynthetic1234567890123");
    expect(result.next_cursor).toBeNull();
  });

  it("keeps combined search pages within 20 and removes duplicates across pages", async () => {
    const document = "doxcnSynthetic1234567890123";
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/search/object")) {
        expect(JSON.parse(String(init?.body)).count).toBe(10);
        return Response.json({ code: 0, data: { docs_entities: [{ docs_token: document, docs_type: "docx", title: "Doc" }], has_more: false } });
      }
      if (String(url).includes("/nodes/search")) {
        const second = String(url).includes("page_token=next");
        expect(String(url)).toContain("page_size=10");
        return Response.json({ code: 0, data: { items: [{ node_id: second ? "wikcnSecond123456789012345" : "wikcnFirst123456789012345", obj_token: document, obj_type: 8, title: "Wiki", url: "https://evil.example/", space_id: "spaceSynthetic123456789" }], has_more: !second, page_token: second ? undefined : "next" } });
      }
      throw Error("unexpected_request");
    };
    const ctx = context(request as typeof fetch);
    const first = await search(ctx, { query: "test" });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].url).toContain("example.feishu.cn/wiki/");
    const second = await search(ctx, { query: "test", cursor: first.next_cursor! });
    expect(second.items).toHaveLength(0);
    expect(second.next_cursor).toBeNull();
  });

  it("requires the same document revision on a continuation page", async () => {
    let revision = 3;
    const request = async (url: string | URL | Request) => {
      if (String(url).endsWith("/blocks?page_size=500")) return Response.json({ code: 0, data: { items: [
        { block_id: "root", block_type: 1, children: ["text"] },
        { block_id: "text", block_type: 2, parent_id: "root", text: { elements: [{ text_run: { content: "中".repeat(13_000) } }] } },
      ], has_more: false } });
      if (String(url).endsWith("/doxcnSynthetic1234567890123")) return Response.json({ code: 0, data: { document: { title: "Synthetic", revision_id: revision } } });
      throw Error("unexpected_request");
    };
    const ctx = context(request as typeof fetch);
    const first = await fetchDoc(ctx, { id: "docx:doxcnSynthetic1234567890123" });
    if (typeof first.content !== "string") throw new Error("expected_docx_content");
    expect(first.content.length).toBe(12_000);
    expect(first.has_more).toBe(true);
    revision = 4;
    await expect(fetchDoc(ctx, { id: "docx:doxcnSynthetic1234567890123", cursor: first.next_cursor! })).rejects.toThrow("source_changed");
  });

  it("paginates by Unicode characters without splitting an emoji", async () => {
    const request = async (url: string | URL | Request) => {
      if (String(url).endsWith("/blocks?page_size=500")) return Response.json({ code: 0, data: { items: [
        { block_id: "root", block_type: 1, children: ["text"] },
        { block_id: "text", block_type: 2, parent_id: "root", text: { elements: [{ text_run: { content: "中".repeat(11_999) + "😀末" } }] } },
      ], has_more: false } });
      if (String(url).endsWith("/doxcnSynthetic1234567890123")) return Response.json({ code: 0, data: { document: { title: "Synthetic", revision_id: 3 } } });
      throw Error("unexpected_request");
    };
    const ctx = context(request as typeof fetch);
    const first = await fetchDoc(ctx, { id: "docx:doxcnSynthetic1234567890123" });
    const second = await fetchDoc(ctx, { id: "docx:doxcnSynthetic1234567890123", cursor: first.next_cursor! });
    expect(first.content).toBe("中".repeat(11_999) + "😀");
    expect(second.content).toBe("末");
  });

  it("refuses external URLs before an upstream call", async () => {
    const request = async () => { throw Error("must_not_fetch"); };
    await expect(fetchDoc(context(request as typeof fetch), { id: "https://example.com/docx/doxcnSynthetic1234567890123" })).rejects.toThrow("invalid_resource_url");
  });
});
