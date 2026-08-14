import { encodeHtmlEntities } from "./html.js";
import type { NodeLike } from "./source.js";

const IDENTIFIER_NAME = /^[$A-Z_a-z][$\w]*$/;

export function getStaticChildText(expr: NodeLike): string | null {
  if (expr.type !== "Literal") return null;
  if (expr.value == null || typeof expr.value === "boolean") return "";
  return encodeHtmlEntities(String(expr.value));
}

export function isIgnoredLiteralChild(expr: NodeLike): boolean {
  return expr.type === "Literal" && (expr.value == null || typeof expr.value === "boolean");
}

export function jsxElementNameToExpression(
  name: NodeLike,
  code: string,
  isComponent: boolean,
): string {
  if (name.type === "JSXIdentifier") {
    const tagName = String(name.name ?? "");
    return isComponent ? tagName : JSON.stringify(tagName);
  }

  if (name.type === "JSXMemberExpression" || name.type === "JSXNamespacedName") {
    if (name.type === "JSXNamespacedName") return JSON.stringify(code.slice(name.start, name.end));
    return code.slice(name.start, name.end);
  }

  return code.slice(name.start, name.end);
}

export function isComponentElementName(name: NodeLike): boolean {
  if (name.type === "JSXMemberExpression") return true;
  if (name.type !== "JSXIdentifier") return false;
  return isComponentTagName(String(name.name ?? ""));
}

export function getElementIdentifierName(name: NodeLike): string | null {
  return name.type === "JSXIdentifier" ? String(name.name ?? "") : null;
}

export function getAttributeName(attr: NodeLike, code: string): string | null {
  const name = attr.name as NodeLike | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") return String(name.name ?? "");
  if (name.type === "JSXNamespacedName") return code.slice(name.start, name.end);
  return null;
}

export function objectPropertyKey(name: string): string {
  return IDENTIFIER_NAME.test(name) ? name : JSON.stringify(name);
}

export function isComponentTagName(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90;
}
