/** Pure HTML serialization policy used by the JSX lowering transform. */

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_ENUMERATED_ATTRIBUTES = new Set(["draggable", "spellcheck"]);
const NAMESPACE_REPLACE_REGEX = /^(xlink|xmlns|xml)([A-Z])/;
const HTML_LOWER_CASE =
  /^(?:accessK|auto[A-Z]|cell|ch|col|cont|cross|dateT|encT|form[A-Z]|frame|hrefL|inputM|maxL|minL|noV|playsI|popoverT|readO|rowS|src[A-Z]|tabI|useM|item[A-Z])/;
const UNSAFE_NAME = /[\s\n\\/='"<>]/;
const ENCODED_ENTITIES = /["&<]/;

export function isVoidHtmlElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

export function isUnsafeHtmlElementName(name: string): boolean {
  return name.includes("\0") || UNSAFE_NAME.test(name);
}

export function normalizeHtmlAttributeName(name: string): string {
  switch (name) {
    case "htmlFor":
      return "for";
    case "className":
      return "class";
    case "defaultChecked":
      return "checked";
    case "defaultSelected":
      return "selected";
    case "defaultValue":
      return "value";
    case "acceptCharset":
      return "accept-charset";
    case "httpEquiv":
      return "http-equiv";
    default:
      if (NAMESPACE_REPLACE_REGEX.test(name)) {
        return name.replace(NAMESPACE_REPLACE_REGEX, "$1:$2").toLowerCase();
      }
      if (HTML_LOWER_CASE.test(name)) return name.toLowerCase();
      return name;
  }
}

export function serializeJsxText(value: string, escape: boolean, trimLastChild: boolean): string {
  let text = "";
  const lines = value.split(/\r\n|\r|\n/);

  for (const [index, originalLine] of lines.entries()) {
    let line = index === 0 ? originalLine : originalLine.trimStart();
    if (index < lines.length - 1 || trimLastChild) line = line.trimEnd();
    if (line === "") continue;
    if (index > 0 && text !== "") text += " ";
    text += line;
  }

  return escape ? encodeHtmlEntities(text) : text;
}

export function encodeHtmlEntities(value: string): string {
  if (value.length === 0 || ENCODED_ENTITIES.test(value) === false) return value;

  let last = 0;
  let out = "";
  for (let index = 0; index < value.length; index++) {
    let replacement = "";
    switch (value.charCodeAt(index)) {
      case 34:
        replacement = "&quot;";
        break;
      case 38:
        replacement = "&amp;";
        break;
      case 60:
        replacement = "&lt;";
        break;
      default:
        continue;
    }

    if (index !== last) out += value.slice(last, index);
    out += replacement;
    last = index + 1;
  }

  if (last !== value.length) out += value.slice(last);
  return out;
}

export function isStringifiedBooleanAttribute(name: string): boolean {
  // Mirrors preact-render-to-string: aria-* and data-* boolean values render as strings.
  return name.charCodeAt(4) === 45 || HTML_ENUMERATED_ATTRIBUTES.has(name);
}
