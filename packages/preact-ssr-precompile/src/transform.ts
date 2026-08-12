/** Preact JSX-to-`jsxTemplate()` lowering, independent from Vite plugin wiring. */

import { generateTransform, rolldownString, type RolldownString } from "rolldown-string";
import {
  applyReplacementsInRange,
  collectIdentifierNames,
  getNodeArray,
  insertPrelude,
  isNode,
  parseProgram,
  uniqueName,
  type NodeLike,
  type Replacement,
} from "./source-analysis.js";
import type { TransformPreactSsrJsxOptions } from "./types.js";

const DEFAULT_IMPORT_SOURCE = "preact";

const DEFAULT_SKIP_ELEMENTS = new Set(["svg", "math", "textarea", "select", "option"]);

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

const HTML_ENUMERATED_ATTRS = new Set(["draggable", "spellcheck"]);
const NAMESPACE_REPLACE_REGEX = /^(xlink|xmlns|xml)([A-Z])/;
const HTML_LOWER_CASE =
  /^(?:accessK|auto[A-Z]|cell|ch|col|cont|cross|dateT|encT|form[A-Z]|frame|hrefL|inputM|maxL|minL|noV|playsI|popoverT|readO|rowS|src[A-Z]|tabI|useM|item[A-Z])/;
const UNSAFE_NAME = /[\s\n\\/='"<>]/;
const ENCODED_ENTITIES = /["&<]/;
const IDENTIFIER_NAME = /^[$A-Z_a-z][$\w]*$/;

/** Transform JSX in a single module. Exposed for tests and non-Vite integrations. */
export function transformPreactSsrJsx(
  code: string,
  id = "preact-ssr.tsx",
  options: TransformPreactSsrJsxOptions = {},
): string | null {
  const s = rolldownString(code, id);
  const changed = transformPreactSsrMagicString(s, id, options);
  if (!changed) return null;
  const result = generateTransform(s, id, true);
  return result ? String(result.code) : null;
}

export function transformPreactSsrMagicString(
  s: RolldownString,
  id: string,
  options: TransformPreactSsrJsxOptions,
): boolean {
  let program: NodeLike;
  try {
    program = parseProgram(id, s.original);
  } catch (error) {
    // Bail out so the next plugin (e.g. @preact/preset-vite) can surface the
    // real parser diagnostics. Warn so silent skips are still discoverable.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preact-ssr-precompile] Skipping ${id}: ${message}`);
    return false;
  }

  const ctx = new TransformContext(s.original, options, collectIdentifierNames(program));
  const replacements = ctx.collectJsxReplacements(program);
  if (replacements.length === 0) return false;

  for (const replacement of replacements) {
    s.update(replacement.start, replacement.end, replacement.code);
  }
  insertPrelude(s, program, ctx.renderPrelude());
  return true;
}

class TransformContext {
  readonly code: string;
  readonly dynamicProps: Set<string>;
  readonly importSource: string;
  readonly skipElements: Set<string>;
  readonly jsxIdent: string;
  readonly jsxTemplateIdent: string;
  readonly jsxAttrIdent: string;
  readonly jsxEscapeIdent: string;

  private templateIndex = 0;
  private readonly takenNames: Set<string>;
  private readonly templates: Array<{ name: string; strings: string[] }> = [];
  private readonly usedHelpers = new Set<"jsx" | "jsxTemplate" | "jsxAttr" | "jsxEscape">();

  constructor(code: string, options: TransformPreactSsrJsxOptions, takenNames: Set<string>) {
    this.takenNames = takenNames;
    this.code = code;
    this.importSource = options.importSource ?? DEFAULT_IMPORT_SOURCE;
    this.dynamicProps = new Set(options.dynamicProps ?? []);
    this.skipElements = new Set([...DEFAULT_SKIP_ELEMENTS, ...(options.skipElements ?? [])]);
    this.jsxIdent = uniqueName("_jsx", takenNames);
    this.jsxTemplateIdent = uniqueName("_jsxTemplate", takenNames);
    this.jsxAttrIdent = uniqueName("_jsxAttr", takenNames);
    this.jsxEscapeIdent = uniqueName("_jsxEscape", takenNames);
  }

  collectJsxReplacements(node: NodeLike): Replacement[] {
    const replacements: Replacement[] = [];
    this.collectJsxReplacementsInto(node, replacements);
    return replacements.sort((a, b) => a.start - b.start);
  }

  renderPrelude(): string {
    const importMap: Array<["jsx" | "jsxTemplate" | "jsxAttr" | "jsxEscape", string]> = [
      ["jsx", this.jsxIdent],
      ["jsxTemplate", this.jsxTemplateIdent],
      ["jsxAttr", this.jsxAttrIdent],
      ["jsxEscape", this.jsxEscapeIdent],
    ];
    const imports = importMap
      .filter(([helper]) => this.usedHelpers.has(helper))
      .map(([helper, alias]) => `${helper} as ${alias}`);

    if (imports.length === 0 && this.templates.length === 0) return "";

    const lines = [
      `import { ${imports.join(", ")} } from ${JSON.stringify(`${this.importSource}/jsx-runtime`)};`,
    ];

    for (const template of this.templates) {
      lines.push(
        `const ${template.name} = [${template.strings.map((value) => JSON.stringify(value)).join(", ")}];`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  serializeJsx(node: NodeLike): string {
    if (node.type === "JSXFragment") {
      const strings = [""];
      const dynamics: string[] = [];
      this.serializeChildrenToTemplate(getNodeArray(node.children), strings, dynamics, false);
      return this.genTemplate(strings, dynamics);
    }

    if (node.type !== "JSXElement") {
      return this.code.slice(node.start, node.end);
    }

    const opening = node.openingElement as NodeLike;
    if (!this.isSerializableOpening(opening)) {
      return this.serializeJsxToCall(node);
    }

    const strings: string[] = [];
    const dynamics: string[] = [];
    this.serializeElementToTemplate(node, strings, dynamics);
    return this.genTemplate(strings, dynamics);
  }

  renderExpression(expr: NodeLike): string {
    const replacements: Replacement[] = [];
    this.collectJsxReplacementsInto(expr, replacements);
    if (replacements.length === 0) return this.code.slice(expr.start, expr.end);
    return applyReplacementsInRange(
      this.code,
      expr.start,
      expr.end,
      replacements.sort((a, b) => a.start - b.start),
    );
  }

  private collectJsxReplacementsInto(node: unknown, replacements: Replacement[]): void {
    if (!isNode(node)) return;

    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      replacements.push({ start: node.start, end: node.end, code: this.serializeJsx(node) });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "comments") continue;
      if (Array.isArray(value)) {
        for (const item of value) this.collectJsxReplacementsInto(item, replacements);
      } else if (isNode(value)) {
        this.collectJsxReplacementsInto(value, replacements);
      }
    }
  }

  private serializeElementToTemplate(node: NodeLike, strings: string[], dynamics: string[]): void {
    const opening = node.openingElement as NodeLike;

    if (!this.isSerializableOpening(opening)) {
      strings.push("");
      dynamics.push(this.serializeJsxToCall(node));
      return;
    }

    if (strings.length === 0) strings.push("");

    const tagName = getElementIdentifierName(opening.name as NodeLike) ?? "";
    strings[strings.length - 1] += `<${encodeEntities(tagName)}`;

    for (const attr of getNodeArray(opening.attributes)) {
      if (attr.type !== "JSXAttribute") continue;
      this.serializeAttributeToTemplate(attr, strings, dynamics);
    }

    const children = getNodeArray(node.children);
    if (VOID_ELEMENTS.has(tagName)) {
      strings[strings.length - 1] += "/>";
      return;
    }

    strings[strings.length - 1] += ">";
    this.serializeChildrenToTemplate(children, strings, dynamics, true);
    strings[strings.length - 1] += `</${tagName}>`;
  }

  private serializeAttributeToTemplate(
    attr: NodeLike,
    strings: string[],
    dynamics: string[],
  ): void {
    const rawAttrName = getAttributeName(attr, this.code);
    if (!rawAttrName) return;

    const attrName = normalizeHtmlAttrName(rawAttrName);

    if (this.dynamicProps.has(rawAttrName) || attrName === "key" || attrName === "ref") {
      strings.push("");
      dynamics.push(this.jsxAttrCall(attrName, this.getAttributeValueExpression(attr)));
      return;
    }

    const value = attr.value as NodeLike | null | undefined;
    if (!value) {
      this.appendStaticAttribute(strings, attrName, true);
      return;
    }

    if (value.type === "Literal") {
      this.appendStaticAttribute(strings, attrName, value.value);
      return;
    }

    if (value.type === "JSXExpressionContainer") {
      const expr = value.expression as NodeLike | null | undefined;
      if (!expr || expr.type === "JSXEmptyExpression") return;

      if (expr.type === "Literal") {
        this.appendStaticAttribute(strings, attrName, expr.value);
        return;
      }

      strings.push("");
      dynamics.push(this.jsxAttrCall(attrName, this.renderExpression(expr)));
      return;
    }

    if (value.type === "JSXElement" || value.type === "JSXFragment") {
      strings.push("");
      dynamics.push(this.jsxAttrCall(attrName, this.serializeJsx(value)));
    }
  }

  private serializeChildrenToTemplate(
    children: NodeLike[],
    strings: string[],
    dynamics: string[],
    isParentSerializable: boolean,
  ): void {
    for (const [index, child] of children.entries()) {
      if (child.type === "JSXText") {
        const text = jsxTextToString(
          String(child.value ?? ""),
          true,
          isParentSerializable && index === children.length - 1,
        );
        strings[strings.length - 1] += text;
        continue;
      }

      if (child.type === "JSXExpressionContainer") {
        const expr = child.expression as NodeLike | null | undefined;
        if (!expr || expr.type === "JSXEmptyExpression") continue;

        const staticText = getStaticChildText(expr);
        if (staticText != null) {
          strings[strings.length - 1] += staticText;
          continue;
        }

        strings.push("");
        this.usedHelpers.add("jsxEscape");
        dynamics.push(`${this.jsxEscapeIdent}(${this.renderExpression(expr)})`);
        continue;
      }

      if (child.type === "JSXElement") {
        this.serializeElementToTemplate(child, strings, dynamics);
        continue;
      }

      if (child.type === "JSXFragment") {
        this.serializeChildrenToTemplate(getNodeArray(child.children), strings, dynamics, false);
      }
    }
  }

  private serializeJsxToCall(node: NodeLike): string {
    // JSXFragments are always routed through the template path in serializeJsx,
    // so this method is only ever called with JSXElement nodes.
    const opening = node.openingElement as NodeLike;
    const isComponent = isComponentElementName(opening.name as NodeLike);
    const typeExpr = jsxElementNameToExpression(opening.name as NodeLike, this.code, isComponent);
    const props: string[] = [];
    let keyExpr: string | undefined;

    for (const attr of getNodeArray(opening.attributes)) {
      if (attr.type === "JSXSpreadAttribute") {
        const argument = attr.argument as NodeLike;
        props.push(`...${this.renderExpression(argument)}`);
        continue;
      }

      if (attr.type !== "JSXAttribute") continue;
      const rawAttrName = getAttributeName(attr, this.code);
      if (!rawAttrName) continue;
      const propName = isComponent ? rawAttrName : normalizeHtmlAttrName(rawAttrName);
      const value = attr.value as NodeLike | null | undefined;

      if (propName === "key") {
        keyExpr = value ? this.getAttributeValueExpression(attr) : "true";
        continue;
      }

      props.push(
        `${objectPropertyKey(propName)}: ${value ? this.getAttributeValueExpression(attr) : "true"}`,
      );
    }

    const children = this.serializeChildrenToExpression(getNodeArray(node.children));
    if (children) props.push(`children: ${children}`);

    const propsExpr = props.length > 0 ? `{ ${props.join(", ")} }` : "null";
    const args = [typeExpr, propsExpr];
    if (keyExpr) args.push(keyExpr);
    this.usedHelpers.add("jsx");
    return `${this.jsxIdent}(${args.join(", ")})`;
  }

  private serializeChildrenToExpression(children: NodeLike[]): string | null {
    const values: string[] = [];

    for (const [index, child] of children.entries()) {
      if (child.type === "JSXText") {
        const text = jsxTextToString(
          String(child.value ?? ""),
          false,
          index === children.length - 1,
        );
        if (text !== "") values.push(JSON.stringify(text));
        continue;
      }

      if (child.type === "JSXExpressionContainer") {
        const expr = child.expression as NodeLike | null | undefined;
        if (!expr || expr.type === "JSXEmptyExpression") continue;
        if (isIgnoredLiteralChild(expr)) continue;
        values.push(this.renderExpression(expr));
        continue;
      }

      if (child.type === "JSXElement" || child.type === "JSXFragment") {
        values.push(this.serializeJsx(child));
      }
    }

    if (values.length === 0) return null;
    if (values.length === 1) return values[0];
    return `[${values.join(", ")}]`;
  }

  private getAttributeValueExpression(attr: NodeLike): string {
    const value = attr.value as NodeLike | null | undefined;
    if (!value) return "true";

    if (value.type === "Literal") {
      return JSON.stringify(String(value.value ?? ""));
    }

    if (value.type === "JSXExpressionContainer") {
      const expr = value.expression as NodeLike | null | undefined;
      if (!expr || expr.type === "JSXEmptyExpression") return "undefined";
      return this.renderExpression(expr);
    }

    if (value.type === "JSXElement" || value.type === "JSXFragment") {
      return this.serializeJsx(value);
    }

    return this.code.slice(value.start, value.end);
  }

  private appendStaticAttribute(strings: string[], attrName: string, value: unknown): void {
    if (value == null) return;

    if (isStringifiedBooleanAttr(attrName) && typeof value === "boolean") {
      strings[strings.length - 1] +=
        ` ${encodeEntities(attrName)}=${JSON.stringify(String(value))}`;
      return;
    }

    if (value === false || typeof value === "function" || typeof value === "object") return;

    if (value === true || value === "") {
      strings[strings.length - 1] += ` ${encodeEntities(attrName)}`;
      return;
    }

    strings[strings.length - 1] +=
      ` ${encodeEntities(attrName)}=${JSON.stringify(encodeEntities(String(value)))}`;
  }

  private jsxAttrCall(attrName: string, expression: string): string {
    const serializedName = JSON.stringify(attrName);
    this.usedHelpers.add("jsxAttr");
    const attr = isStringifiedBooleanAttr(attrName)
      ? `((value) => typeof value === "boolean" ? ${this.jsxAttrIdent}(${serializedName}, String(value)) : ${this.jsxAttrIdent}(${serializedName}, value))(${expression})`
      : `${this.jsxAttrIdent}(${serializedName}, ${expression})`;
    return `((attr) => attr ? " " + attr : "")(${attr})`;
  }

  private genTemplate(strings: string[], dynamics: string[]): string {
    const templateName = uniqueName(`$$_tpl_${++this.templateIndex}`, this.takenNames);
    this.templates.push({ name: templateName, strings });
    this.usedHelpers.add("jsxTemplate");
    return `${this.jsxTemplateIdent}(${[templateName, ...dynamics].join(", ")})`;
  }

  private isSerializableOpening(opening: NodeLike): boolean {
    const name = getElementIdentifierName(opening.name as NodeLike);
    if (!name) return false;
    if (isComponentTagName(name)) return false;
    if (this.skipElements.has(name)) return false;
    if (name.includes("-")) return false;
    if (name.includes("\0") || UNSAFE_NAME.test(name)) return false;

    for (const attr of getNodeArray(opening.attributes)) {
      if (attr.type === "JSXSpreadAttribute") return false;
      if (attr.type !== "JSXAttribute") continue;
      const attrName = getAttributeName(attr, this.code);
      if (attrName === "dangerouslySetInnerHTML") return false;
    }

    return true;
  }
}

function getStaticChildText(expr: NodeLike): string | null {
  if (expr.type !== "Literal") return null;
  if (expr.value == null || typeof expr.value === "boolean") return "";
  return encodeEntities(String(expr.value));
}

function isIgnoredLiteralChild(expr: NodeLike): boolean {
  return expr.type === "Literal" && (expr.value == null || typeof expr.value === "boolean");
}

function jsxElementNameToExpression(name: NodeLike, code: string, isComponent: boolean): string {
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

function isComponentElementName(name: NodeLike): boolean {
  if (name.type === "JSXMemberExpression") return true;
  if (name.type !== "JSXIdentifier") return false;
  return isComponentTagName(String(name.name ?? ""));
}

function isComponentTagName(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90;
}

function getElementIdentifierName(name: NodeLike): string | null {
  return name.type === "JSXIdentifier" ? String(name.name ?? "") : null;
}

function getAttributeName(attr: NodeLike, code: string): string | null {
  const name = attr.name as NodeLike | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") return String(name.name ?? "");
  if (name.type === "JSXNamespacedName") return code.slice(name.start, name.end);
  return null;
}

function normalizeHtmlAttrName(name: string): string {
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
      if (NAMESPACE_REPLACE_REGEX.test(name))
        return name.replace(NAMESPACE_REPLACE_REGEX, "$1:$2").toLowerCase();
      if (HTML_LOWER_CASE.test(name)) return name.toLowerCase();
      return name;
  }
}

function objectPropertyKey(name: string): string {
  return IDENTIFIER_NAME.test(name) ? name : JSON.stringify(name);
}

function jsxTextToString(value: string, escape: boolean, trimLastChild: boolean): string {
  let text = "";
  const lines = value.split(/\r\n|\r|\n/);

  for (const [index, originalLine] of lines.entries()) {
    let line = index === 0 ? originalLine : originalLine.trimStart();
    if (index < lines.length - 1 || trimLastChild) line = line.trimEnd();
    if (line === "") continue;
    if (index > 0 && text !== "") text += " ";
    text += line;
  }

  return escape ? encodeEntities(text) : text;
}

function encodeEntities(value: string): string {
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

function isStringifiedBooleanAttr(name: string): boolean {
  // Mirrors preact-render-to-string: aria-* and data-* boolean values render as strings.
  return name.charCodeAt(4) === 45 || HTML_ENUMERATED_ATTRS.has(name);
}
