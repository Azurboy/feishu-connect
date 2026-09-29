import { DurableObject } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { allowed } from "./upstream";

export type Env = {
  OAUTH_KV: KVNamespace;
  USERS: DurableObjectNamespace<UserVault>;
  APP_URL: string;
  FEISHU_BASE_URL: string;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  ALLOWED_TENANTS: string;
  ALLOWED_USERS: string;
  CURSOR_SECRET: string;
  SESSION_SECRET: string;
  VAULT_KEY: string;
  OAUTH_PROVIDER: unknown;
};

type Credentials = { access: string; refresh: string; accessExpires: number; refreshExpires: number; openId: string; tenantKey: string; generation: number };
type Stored = { iv: string; ciphertext: string };
export type Pending = { credentials: Omit<Credentials, "openId" | "tenantKey" | "generation">; identity: { open_id: string; tenant_key: string }; request: AuthRequest; name: string; expires: number; generation: number };
const toBytes = (value: string) => new TextEncoder().encode(value);
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export class UserVault extends DurableObject<Env> {
  private refreshing?: Promise<string>;

  private async key(): Promise<CryptoKey> {
    const material = fromBase64(this.env.VAULT_KEY);
    if (material.length !== 32) throw new Error("invalid_vault_key");
    return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async read(): Promise<Credentials | null> {
    const saved = await this.ctx.storage.get<Stored>("credentials");
    if (!saved) return null;
    return this.unseal<Credentials>(saved);
  }

  private async seal(value: unknown): Promise<Stored> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), toBytes(JSON.stringify(value)));
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) };
  }

  private async unseal<T>(saved: Stored): Promise<T> {
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(saved.iv) }, await this.key(), fromBase64(saved.ciphertext));
    return JSON.parse(new TextDecoder().decode(decoded)) as T;
  }

  private async write(value: Credentials): Promise<void> {
    const sealed = await this.seal(value);
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get<number>("generation") ?? 0) !== value.generation) throw new Error("connection_revoked");
      await txn.put("credentials", sealed);
    });
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, value.accessExpires - 50_000));
  }

  async savePending(handle: string, value: Omit<Pending, "generation">): Promise<void> {
    const generation = await this.ctx.storage.get<number>("generation") ?? 0;
    await this.ctx.storage.put(`pending:${handle}`, await this.seal({ ...value, generation }));
    const prior = await this.ctx.storage.getAlarm();
    if (!prior || prior > value.expires) await this.ctx.storage.setAlarm(value.expires);
  }

  async consumePending(handle: string): Promise<Pending | null> {
    const saved = await this.ctx.storage.transaction(async (txn) => {
      const value = await txn.get<Stored>(`pending:${handle}`);
      if (value) await txn.delete(`pending:${handle}`);
      return value;
    });
    if (!saved) return null;
    const value = await this.unseal<Pending>(saved);
    return value.expires > Date.now() ? value : null;
  }

  async save(value: Credentials): Promise<void> {
    if (!value.access || !value.refresh || value.refreshExpires <= Date.now()) throw new Error("invalid_feishu_credentials");
    await this.write(value);
    await this.ctx.storage.delete("needs_reauth");
  }

  async status(): Promise<"connected" | "needs_reauth" | "disconnected"> {
    if (await this.ctx.storage.get("needs_reauth")) return "needs_reauth";
    const value = await this.read();
    return value && value.refreshExpires > Date.now() && allowed(this.env, { open_id: value.openId, tenant_key: value.tenantKey }) ? "connected" : "disconnected";
  }

  async markUsed(clientId: string): Promise<void> {
    if (clientId) await this.ctx.storage.put(`used:${clientId}`, Date.now());
  }

  async lastUsed(clientId: string): Promise<number | null> {
    return await this.ctx.storage.get<number>(`used:${clientId}`) ?? null;
  }

  async blockGrant(grantId: string): Promise<void> {
    await this.ctx.storage.put(`blocked:${grantId}`, true);
  }

  async isBlocked(grantId: string): Promise<boolean> {
    return !!await this.ctx.storage.get(`blocked:${grantId}`);
  }

  async accessToken(): Promise<string> {
    const value = await this.read();
    if (!value || await this.ctx.storage.get("needs_reauth")) throw new Error("needs_reauth");
    if (!allowed(this.env, { open_id: value.openId, tenant_key: value.tenantKey })) throw new Error("access_denied");
    if (value.accessExpires > Date.now() + 60_000) return value.access;
    this.refreshing ??= this.refresh(value).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refresh(value: Credentials): Promise<string> {
    if (value.refreshExpires <= Date.now()) {
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    let response: Response;
    try {
      response = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: value.refresh, client_id: this.env.FEISHU_APP_ID, client_secret: this.env.FEISHU_APP_SECRET }),
        redirect: "error",
        signal: AbortSignal.timeout(7_000),
      });
    } catch {
      throw new Error("upstream_unavailable");
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new Error("upstream_unavailable");
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number" || typeof data.refresh_token_expires_in !== "number") {
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    const now = Date.now();
    await this.write({ ...value, access: data.access_token, refresh: data.refresh_token, accessExpires: now + data.expires_in * 1000, refreshExpires: now + data.refresh_token_expires_in * 1000 });
    return data.access_token;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("generation", (await txn.get<number>("generation") ?? 0) + 1);
      await txn.delete("credentials");
      await txn.delete("needs_reauth");
      const pending = await txn.list({ prefix: "pending:" });
      for (const key of pending.keys()) await txn.delete(key);
    });
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const pending = await this.ctx.storage.list<Stored>({ prefix: "pending:" });
    let next = Infinity;
    for (const [key, saved] of pending) {
      const value = await this.unseal<Pending>(saved);
      if (value.expires <= Date.now()) await this.ctx.storage.delete(key);
      else next = Math.min(next, value.expires);
    }
    try { await this.accessToken(); } catch (error) {
      if (error instanceof Error && error.message === "upstream_unavailable") next = Math.min(next, Date.now() + 60_000);
    }
    const current = await this.read();
    if (current && !await this.ctx.storage.get("needs_reauth") && current.accessExpires > Date.now() + 50_000) next = Math.min(next, current.accessExpires - 50_000);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
  }
}

export function vaultFor(env: Env, user: string): DurableObjectStub<UserVault> {
  return env.USERS.get(env.USERS.idFromName(user));
}
