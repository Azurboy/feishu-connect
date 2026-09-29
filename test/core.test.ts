import { describe, expect, it } from "vitest";
import { readCursor, signCursor } from "../src/cursor";
import { renderBlocks } from "../src/content";
import { FeishuClient } from "../src/feishu";
import { fetchDoc, search, type ToolContext } from "../src/tools";

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

  it("refuses external URLs before an upstream call", async () => {
    const request = async () => { throw Error("must_not_fetch"); };
    await expect(fetchDoc(context(request as typeof fetch), { id: "https://example.com/docx/doxcnSynthetic1234567890123" })).rejects.toThrow("invalid_resource_url");
  });
});
