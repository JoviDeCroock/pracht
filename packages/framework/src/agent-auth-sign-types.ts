/** Ed25519 private key in JWK form — the `d` (private) and `x` (public) pair. */
export interface AgentSigningJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** Base64url private scalar. */
  d: string;
  /** Base64url public key. */
  x: string;
}

export interface AgentSignatureOptions {
  /** HTTPS identity serving the agent's public key directory. */
  agent: string;
  privateKeyJwk: AgentSigningJwk;
  /** Defaults to the RFC 8037 thumbprint of the public key. */
  keyId?: string;
  /** Signature validity window in seconds. Default 300; maximum 24 hours. */
  lifetimeSeconds?: number;
  /** Unix timestamp in seconds. Defaults to now. */
  createdAt?: number;
  /** RFC 8941 signature label. Default `sig1`. */
  label?: string;
  /** Extra covered components after the required authority and agent identity. */
  additionalComponents?: readonly string[];
  /** Optional nonce parameter. */
  nonce?: string;
}

export interface AgentSignatureHeaders {
  "signature-agent": string;
  "signature-input": string;
  signature: string;
}

export interface GeneratedAgentKeyPair {
  keyId: string;
  privateKeyJwk: AgentSigningJwk;
  publicKeyJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}
