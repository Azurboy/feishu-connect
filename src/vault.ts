import { DurableObject } from "cloudflare:workers";

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
  VAULT_KEY: string;
  OAUTH_PROVIDER: unknown;
};

type Credentials = { access: string; refresh: string; accessExpires: number; refreshExpires: number };
type Stored = { iv: string; ciphertext: string };
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
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(saved.iv) }, await this.key(), fromBase64(saved.ciphertext));
    return JSON.parse(new TextDecoder().decode(decoded)) as Credentials;
  }

  private async write(value: Credentials): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), toBytes(JSON.stringify(value)));
    await this.ctx.storage.put("credentials", { iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) });
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, value.accessExpires - 50_000));
  }

  async save(value: Credentials): Promise<void> {
    if (!value.access || !value.refresh || value.refreshExpires <= Date.now()) throw new Error("invalid_feishu_credentials");
    await this.write(value);
    await this.ctx.storage.delete("needs_reauth");
  }

  async status(): Promise<"connected" | "needs_reauth" | "disconnected"> {
    if (await this.ctx.storage.get("needs_reauth")) return "needs_reauth";
    const value = await this.read();
    return value && value.refreshExpires > Date.now() ? "connected" : "disconnected";
  }

  async accessToken(): Promise<string> {
    const value = await this.read();
    if (!value || await this.ctx.storage.get("needs_reauth")) throw new Error("needs_reauth");
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
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    if (!response.ok) {
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number" || typeof data.refresh_token_expires_in !== "number") {
      await this.ctx.storage.put("needs_reauth", true);
      throw new Error("needs_reauth");
    }
    const now = Date.now();
    await this.write({ access: data.access_token, refresh: data.refresh_token, accessExpires: now + data.expires_in * 1000, refreshExpires: now + data.refresh_token_expires_in * 1000 });
    return data.access_token;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    try { await this.accessToken(); } catch { /* status records the need to reconnect */ }
  }
}

export function vaultFor(env: Env, user: string): DurableObjectStub<UserVault> {
  return env.USERS.get(env.USERS.idFromName(user));
}
