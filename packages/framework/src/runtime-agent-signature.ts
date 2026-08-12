/**
 * Minimal RFC 8941 parsing and RFC 9421 signature-base construction for Web
 * Bot Auth. The parser deliberately supports only the structured dictionary
 * shapes used by Signature-Input, Signature, and Signature-Agent.
 */

export interface SignatureInputMember {
  label: string;
  /** Covered component identifiers, e.g. `@authority`, `signature-agent`. */
  components: string[];
  /** Signature parameters: created/expires are numbers, the rest strings. */
  params: Record<string, string | number>;
  /** Raw inner-list serialization used by the `@signature-params` base line. */
  raw: string;
}

/** Split a dictionary header on top-level commas (quotes and inner lists respected). */
function splitDictionaryMembers(value: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      members.push(value.slice(start, index));
      start = index + 1;
    }
  }
  members.push(value.slice(start));
  return members.map((member) => member.trim()).filter((member) => member !== "");
}

/** Parse `;key=value;...` parameters. Returns null on malformed input. */
function parseParameters(raw: string): Record<string, string | number> | null {
  const params: Record<string, string | number> = {};
  let rest = raw;
  while (rest !== "") {
    if (!rest.startsWith(";")) return null;
    rest = rest.slice(1).trimStart();
    const match = /^([a-z*][a-z0-9_.*-]*)=/.exec(rest);
    if (!match) return null;
    const key = match[1];
    rest = rest.slice(match[0].length);
    if (rest.startsWith('"')) {
      const end = findStringEnd(rest);
      if (end === -1) return null;
      params[key] = unescapeSfString(rest.slice(1, end));
      rest = rest.slice(end + 1);
    } else {
      const valueMatch = /^-?\d+/.exec(rest);
      if (!valueMatch) return null;
      params[key] = Number(valueMatch[0]);
      rest = rest.slice(valueMatch[0].length);
    }
    rest = rest.trimStart();
  }
  return params;
}

function findStringEnd(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === '"') return index;
  }
  return -1;
}

function unescapeSfString(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Parse a `Signature-Input` dictionary. A malformed member rejects the whole
 * header so verification never proceeds from a partial parse.
 */
export function parseSignatureInput(header: string): SignatureInputMember[] | null {
  const members: SignatureInputMember[] = [];
  for (const memberText of splitDictionaryMembers(header)) {
    const eq = memberText.indexOf("=");
    if (eq === -1) return null;
    const label = memberText.slice(0, eq).trim();
    const raw = memberText.slice(eq + 1).trim();
    if (!raw.startsWith("(")) return null;
    const close = raw.indexOf(")");
    if (close === -1) return null;

    const componentsText = raw.slice(1, close).trim();
    const components: string[] = [];
    if (componentsText !== "") {
      for (const item of componentsText.split(/\s+/)) {
        if (!item.startsWith('"') || !item.endsWith('"') || item.length < 2) return null;
        components.push(unescapeSfString(item.slice(1, -1)));
      }
    }

    const params = parseParameters(raw.slice(close + 1).trim());
    if (!params) return null;
    members.push({ label, components, params, raw });
  }
  return members;
}

/** Parse a `Signature` dictionary of byte sequences: `label=:base64:`. */
export function parseSignatureHeader(header: string): Record<string, Uint8Array> | null {
  const signatures: Record<string, Uint8Array> = {};
  for (const memberText of splitDictionaryMembers(header)) {
    const match = /^([^=]+)=:([A-Za-z0-9+/]*={0,2}):$/.exec(memberText.trim());
    if (!match) return null;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(match[2]);
    } catch {
      return null;
    }
    signatures[match[1].trim()] = bytes;
  }
  return signatures;
}

/**
 * Build the signature base for the covered components. Unknown derived
 * components and missing headers reject the entire signature.
 */
export function buildSignatureBase(request: Request, member: SignatureInputMember): string | null {
  const url = new URL(request.url);
  const lines: string[] = [];

  for (const component of member.components) {
    let value: string | null = null;
    if (component.startsWith("@")) {
      switch (component) {
        case "@authority":
          value = url.host.toLowerCase();
          break;
        case "@method":
          value = request.method.toUpperCase();
          break;
        case "@scheme":
          value = url.protocol.replace(/:$/, "");
          break;
        case "@target-uri":
          value = request.url;
          break;
        case "@path":
          value = url.pathname;
          break;
        case "@query":
          value = url.search === "" ? "?" : url.search;
          break;
        default:
          return null;
      }
    } else {
      const headerValue = request.headers.get(component);
      if (headerValue === null) return null;
      value = headerValue.trim().replace(/[\r\n]+\s*/g, " ");
    }
    lines.push(`"${component}": ${value}`);
  }

  lines.push(`"@signature-params": ${member.raw}`);
  return lines.join("\n");
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Parse the Signature-Agent sf-string into a validated https URL. */
export function parseSignatureAgent(header: string): URL | null {
  const trimmed = header.trim();
  let value = trimmed;
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) return null;
    value = unescapeSfString(trimmed.slice(1, -1));
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}
