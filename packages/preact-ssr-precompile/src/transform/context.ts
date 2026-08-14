/** Mutable serialization context for one Preact JSX lowering pass. */

import {
  encodeHtmlEntities,
  isStringifiedBooleanAttribute,
  isUnsafeHtmlElementName,
  isVoidHtmlElement,
  normalizeHtmlAttributeName,
  serializeJsxText,
} from "./html.js";
import {
  getAttributeName,
  getElementIdentifierName,
  getStaticChildText,
  isComponentElementName,
  isComponentTagName,
  isIgnoredLiteralChild,
  jsxElementNameToExpression,
  objectPropertyKey,
} from "./jsx-syntax.js";
import {
  applyReplacementsInRange,
  getNodeArray,
  isNode,
  uniqueName,
  type NodeLike,
  type Replacement,
} from "./source.js";
import type { TransformPreactSsrJsxOptions } from "../types.js";

const DEFAULT_IMPORT_SOURCE = "preact";

const DEFAULT_SKIP_ELEMENTS = new Set(["svg", "math", "textarea", "select", "option"]);

export class TransformContext {
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
    strings[strings.length - 1] += `<${encodeHtmlEntities(tagName)}`;

    for (const attr of getNodeArray(opening.attributes)) {
      if (attr.type !== "JSXAttribute") continue;
      this.serializeAttributeToTemplate(attr, strings, dynamics);
    }

    const children = getNodeArray(node.children);
    if (isVoidHtmlElement(tagName)) {
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

    const attrName = normalizeHtmlAttributeName(rawAttrName);

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
        const text = serializeJsxText(
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
      const propName = isComponent ? rawAttrName : normalizeHtmlAttributeName(rawAttrName);
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
        const text = serializeJsxText(
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

    if (isStringifiedBooleanAttribute(attrName) && typeof value === "boolean") {
      strings[strings.length - 1] +=
        ` ${encodeHtmlEntities(attrName)}=${JSON.stringify(String(value))}`;
      return;
    }

    if (value === false || typeof value === "function" || typeof value === "object") return;

    if (value === true || value === "") {
      strings[strings.length - 1] += ` ${encodeHtmlEntities(attrName)}`;
      return;
    }

    strings[strings.length - 1] +=
      ` ${encodeHtmlEntities(attrName)}=${JSON.stringify(encodeHtmlEntities(String(value)))}`;
  }

  private jsxAttrCall(attrName: string, expression: string): string {
    const serializedName = JSON.stringify(attrName);
    this.usedHelpers.add("jsxAttr");
    const attr = isStringifiedBooleanAttribute(attrName)
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
    if (isUnsafeHtmlElementName(name)) return false;

    for (const attr of getNodeArray(opening.attributes)) {
      if (attr.type === "JSXSpreadAttribute") return false;
      if (attr.type !== "JSXAttribute") continue;
      const attrName = getAttributeName(attr, this.code);
      if (attrName === "dangerouslySetInnerHTML") return false;
    }

    return true;
  }
}
