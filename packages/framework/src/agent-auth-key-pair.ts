import type { AgentSigningJwk, GeneratedAgentKeyPair } from "./agent-auth-sign-types.ts";
import { ed25519JwkThumbprint } from "./runtime-agent-directory.ts";

/** Generate an Ed25519 signing keypair and its RFC 8037 thumbprint. */
export async function generateAgentKeyPair(): Promise<GeneratedAgentKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as {
    d?: string;
    x?: string;
  };
  if (!privateJwk.d || !privateJwk.x) {
    throw new Error("[pracht] Ed25519 key generation did not produce a usable JWK.");
  }

  const privateKeyJwk: AgentSigningJwk = {
    crv: "Ed25519",
    d: privateJwk.d,
    kty: "OKP",
    x: privateJwk.x,
  };
  return {
    keyId: await ed25519JwkThumbprint(privateJwk.x),
    privateKeyJwk,
    publicKeyJwk: { crv: "Ed25519", kty: "OKP", x: privateJwk.x },
  };
}
