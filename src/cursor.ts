export type Cursor = {
  kind: "search-doc" | "search-wiki" | "search-all" | "fetch" | "wiki-list";
  user: string;
  client: string;
  resource: string;
  position: string | number;
  revision?: number;
  expires: number;
};

const bytes = (value: string) => new TextEncoder().encode(value);
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0));
const key = async (secret: string) => crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signCursor(secret: string, value: Omit<Cursor, "expires">): Promise<string> {
  const encoded = b64(bytes(JSON.stringify({ ...value, expires: Date.now() + 15 * 60_000 })));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), bytes(encoded));
  return `${encoded}.${b64(new Uint8Array(signature))}`;
}

export async function readCursor(secret: string, input: string, expected: Pick<Cursor, "kind" | "user" | "client" | "resource">): Promise<Cursor> {
  try {
    const parts = input.split(".");
    if (parts.length !== 2 || input.length > 4096) throw Error();
    if (!await crypto.subtle.verify("HMAC", await key(secret), unb64(parts[1]), bytes(parts[0]))) throw Error();
    const value = JSON.parse(new TextDecoder().decode(unb64(parts[0]))) as Cursor;
    if (value.expires < Date.now() || value.kind !== expected.kind || value.user !== expected.user || value.client !== expected.client || value.resource !== expected.resource) throw Error();
    if (typeof value.position !== "number" && typeof value.position !== "string") throw Error();
    return value;
  } catch {
    throw new Error("invalid_cursor");
  }
}
