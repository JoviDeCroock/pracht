import type { Plugin } from "vite";
import { parseSync } from "rolldown/utils";
import {
  generateTransform,
  rolldownString,
  withMagicString,
  type RolldownString,
} from "rolldown-string";

type FilterPattern = string | RegExp | ReadonlyArray<string | RegExp>;

type NodeLike = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type Replacement = {
  start: number;
  end: number;
  code: string;
};

export interface PreactSsrPrecompileOptions {
  /** Files to transform. Defaults to JS/TS files, including JSX/TSX. */
  include?: FilterPattern;
  /** Files to skip. Defaults to node_modules. */
  exclude?: FilterPattern;
  /** JSX runtime import source. Imports are generated from `${importSource}/jsx-runtime`. */
  importSource?: string;
  /** Run only for Vite SSR transforms. Defaults to true. */
  ssrOnly?: boolean;
  /** Additional lowercase HTML element names to keep on the normal JSX path. */
  skipElements?: string[];
  /** Attributes that should always be serialized at runtime with `jsxAttr()`. */
  dynamicProps?: string[];
}

export interface TransformPreactSsrJsxOptions {
  importSource?: string;
  skipElements?: string[];
  dynamicProps?: string[];
}

const DEFAULT_INCLUDE = [/\.[cm]?[tj]sx?$/];
const DEFAULT_EXCLUDE = [/node_modules/];
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

/**
 * Create a Vite/Rolldown plugin that precompiles safe Preact JSX for server
 * bundles into `jsxTemplate()` calls understood by `preact-render-to-string`.
 */
export function preactSsrPrecompile(options: PreactSsrPrecompileOptions = {}): Plugin {
  const filter = createSimpleFilter(
    options.include ?? DEFAULT_INCLUDE,
    options.exclude ?? DEFAULT_EXCLUDE,
  );
  const ssrOnly = options.ssrOnly ?? true;

  return {
    name: "preact-ssr-precompile",
    enforce: "pre",

    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:$|\?)/,
      },
      handler: withMagicString(function (s, id, transformOptions?: any) {
        const filename = stripQuery(id);
        if (ssrOnly && transformOptions?.ssr !== true) return;
        if (!filter(filename)) return;
        if (!looksLikeJSX(s.original)) return;

        transformPreactSsrMagicString(s, filename, options);
      }),
    },
  };
}

export default preactSsrPrecompile;

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

function transformPreactSsrMagicString(
  s: RolldownString,
  id: string,
  options: TransformPreactSsrJsxOptions,
): boolean {
  let program: NodeLike;
  try {
    program = parseProgram(id, s.original);
  } catch {
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
    const imports = [
      `jsx as ${this.jsxIdent}`,
      `jsxTemplate as ${this.jsxTemplateIdent}`,
      `jsxAttr as ${this.jsxAttrIdent}`,
      `jsxEscape as ${this.jsxEscapeIdent}`,
    ];
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
    if (rawAttrName === "dangerouslySetInnerHTML") return;

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
    if (node.type === "JSXFragment") {
      const children = this.serializeChildrenToExpression(getNodeArray(node.children));
      return `${this.jsxIdent}(Fragment, ${children ? `{ children: ${children} }` : "null"})`;
    }

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

    if (isAriaOrEnumerated(attrName) && typeof value === "boolean") {
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
    const attr = isAriaOrEnumerated(attrName)
      ? `((value) => typeof value === "boolean" ? ${this.jsxAttrIdent}(${serializedName}, String(value)) : ${this.jsxAttrIdent}(${serializedName}, value))(${expression})`
      : `${this.jsxAttrIdent}(${serializedName}, ${expression})`;
    return `((attr) => attr ? " " + attr : "")(${attr})`;
  }

  private genTemplate(strings: string[], dynamics: string[]): string {
    const templateName = uniqueName(`$$_tpl_${++this.templateIndex}`, this.takenNames);
    this.templates.push({ name: templateName, strings });
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

function isAriaOrEnumerated(name: string): boolean {
  return name.startsWith("aria-") || HTML_ENUMERATED_ATTRS.has(name);
}

function insertPrelude(s: RolldownString, program: NodeLike, prelude: string): void {
  if (prelude.trim() === "") return;

  const insertAt = findPreludeInsertionPoint(s.original, program);
  const needsLeadingNewline = insertAt > 0 && !s.original.slice(0, insertAt).endsWith("\n");
  s.appendLeft(insertAt, `${needsLeadingNewline ? "\n" : ""}${prelude}`);
}

function findPreludeInsertionPoint(code: string, program: NodeLike): number {
  const body = getNodeArray(program.body);
  let insertAt = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;

  for (const statement of body) {
    if (statement.type === "ImportDeclaration") {
      insertAt = Math.max(insertAt, statement.end);
      continue;
    }

    if (statement.type === "ExpressionStatement") {
      const expression = statement.expression as NodeLike | undefined;
      if (expression?.type === "Literal" && typeof expression.value === "string") {
        insertAt = Math.max(insertAt, statement.end);
        continue;
      }
    }

    break;
  }

  while (code[insertAt] === "\r" || code[insertAt] === "\n") insertAt++;
  return insertAt;
}

function applyReplacementsInRange(
  code: string,
  start: number,
  end: number,
  replacements: Replacement[],
): string {
  let cursor = start;
  let out = "";

  for (const replacement of replacements) {
    if (replacement.start < cursor || replacement.end > end) continue;
    out += code.slice(cursor, replacement.start);
    out += replacement.code;
    cursor = replacement.end;
  }

  out += code.slice(cursor, end);
  return out;
}

function collectIdentifierNames(node: unknown): Set<string> {
  const names = new Set<string>();

  function visit(value: unknown): void {
    if (!isNode(value)) return;
    if (
      (value.type === "Identifier" || value.type === "JSXIdentifier") &&
      typeof value.name === "string"
    ) {
      names.add(value.name);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "comments") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (isNode(child)) {
        visit(child);
      }
    }
  }

  visit(node);
  return names;
}

function uniqueName(base: string, takenNames: Set<string>): string {
  let name = base;
  let index = 1;
  while (takenNames.has(name)) {
    name = `${base}_${index++}`;
  }
  takenNames.add(name);
  return name;
}

function getNodeArray(value: unknown): NodeLike[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function isNode(value: unknown): value is NodeLike {
  return !!value && typeof value === "object" && typeof (value as NodeLike).type === "string";
}

function stripQuery(id: string): string {
  return id.split("?", 1)[0];
}

function parseProgram(id: string, code: string): NodeLike {
  const parseOptions = getParseOptions(id, code);
  return parseSync(id, code, {
    lang: parseOptions.lang,
    sourceType: parseOptions.sourceType,
  }).program as unknown as NodeLike;
}

function getParseOptions(
  id: string,
  code: string,
): {
  lang: "js" | "jsx" | "ts" | "tsx";
  sourceType: "module" | "commonjs";
} {
  const filename = stripQuery(id);
  const isCommonJS = /(^|\W)require\s*\(|(^|\W)module\.exports\b|(^|\W)exports\./.test(code);

  let lang: "js" | "jsx" | "ts" | "tsx" = "js";
  if (/\.[cm]?tsx$/i.test(filename)) {
    lang = "tsx";
  } else if (/\.[cm]?ts$/i.test(filename)) {
    lang = looksLikeJSX(code) ? "tsx" : "ts";
  } else if (/\.[cm]?jsx$/i.test(filename)) {
    lang = "jsx";
  } else if (looksLikeJSX(code)) {
    lang = "jsx";
  }

  return {
    lang,
    sourceType: isCommonJS ? "commonjs" : "module",
  };
}

function looksLikeJSX(code: string): boolean {
  return /<>|<\/[A-Za-z]|<[A-Za-z]/.test(code);
}

function createSimpleFilter(
  include: FilterPattern,
  exclude: FilterPattern,
): (id: string) => boolean {
  const includes = normalizeFilterPattern(include);
  const excludes = normalizeFilterPattern(exclude);
  return (id) => matchesAny(id, includes) && !matchesAny(id, excludes);
}

function normalizeFilterPattern(pattern: FilterPattern): Array<string | RegExp> {
  if (Array.isArray(pattern)) return [...(pattern as ReadonlyArray<string | RegExp>)];
  return [pattern as string | RegExp];
}

function matchesAny(id: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return id.includes(pattern);
    return pattern.test(id);
  });
}
