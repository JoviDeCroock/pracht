export const JSX_COMPONENT_RE = /^[A-Z]/;

export const SKIPPED_KEYS = new Set([
  "attributes",
  "decorators",
  "end",
  "exportKind",
  "importKind",
  "optional",
  "phase",
  "raw",
  "returnType",
  "start",
  "superTypeArguments",
  "type",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "value",
]);

export type BindingKind =
  | "catch"
  | "class"
  | "const"
  | "function"
  | "import"
  | "let"
  | "param"
  | "placeholder"
  | "var";

export type ScopeType = "block" | "catch" | "class" | "for" | "function" | "program" | "switch";

export type OxcNode = {
  end: number;
  start: number;
  type: string;
  [key: string]: any;
};

export type Scope = {
  bindings: Map<string, Binding>;
  node: OxcNode | null;
  parent: Scope | null;
  type: ScopeType;
};

export type Binding = {
  kind: BindingKind;
  name: string;
  node: OxcNode | null;
  scope: Scope;
};

export type Reference = {
  name: string;
  node: OxcNode;
  resolvedBinding: Binding | null;
};

export type RetainedStatement = {
  node: OxcNode;
};

export type ScopeAnalysisResult = {
  programScope: Scope;
  referencedTopLevelNames: Set<string>;
  references: Reference[];
};
