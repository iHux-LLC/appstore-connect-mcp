import { SignJWT, importPKCS8 } from "jose";
import type { Config } from "./config.js";
import { readPrivateKey, requireCredentials } from "./config.js";

// Apple rejects tokens that live longer than 20 minutes.
const TOKEN_LIFETIME_SECONDS = 19 * 60;
const REFRESH_MARGIN_SECONDS = 60;

export class TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private key?: CryptoKey;

  constructor(private readonly config: Config) {}

  /** Drops the cached key and token, e.g. after the credentials in the settings file change. */
  reset(): void {
    this.cached = undefined;
    this.key = undefined;
  }

  async getToken(forceRefresh = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (!forceRefresh && this.cached && this.cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
      return this.cached.token;
    }
    const { keyId, issuerId } = requireCredentials(this.config);
    this.key ??= await importPKCS8(readPrivateKey(this.config), "ES256");
    const expiresAt = now + TOKEN_LIFETIME_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
      .setIssuer(issuerId)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .setAudience("appstoreconnect-v1")
      .sign(this.key);
    this.cached = { token, expiresAt };
    return token;
  }
}
