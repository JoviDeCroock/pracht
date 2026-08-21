/**
 * Static analysis of capability sources — shared by the Vite plugin (client
 * projection codegen) and the CLI (`pracht verify`, `pracht typegen`). Every
 * consumer parses the same `defineCapability({ ... })` call sites without
 * executing application code, so keeping the parser here guarantees the build,
 * verification, and type generation can never disagree about what is
 * statically analyzable.
 *
 * Constraint this imposes on capability authors: values the tools need
 * (`expose`, `effect`, `input`, string fields) must be inline literals — no
 * imported constants or spreads. `evaluateLiteral()` parses the literal text
 * as data and returns `undefined` for anything else.
 */

import { capabilityHttpPath, isValidCapabilityHttpPath } from "./protocol.ts";

/**
 * The parts of a capability contract that decide what gets projected to the
 * browser: whether it has an HTTP endpoint, its effect class, whether it
 * registers a WebMCP page tool, and the input schema that tool advertises.
 */
export interface CapabilityProjection {
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  inputSchema: Record<string, unknown> | null;
  /**
   * Remote MCP exposure. Not part of the browser projection — the client
   * bundle never sees it — but the app graph falls back to this extractor
   * when a capability module cannot be executed, and omitting it there would
   * report an MCP-exposed capability as unexposed.
   */
  mcp: boolean;
  /**
   * Per-capability Web Bot Auth policy, or `null` when it inherits the app
   * default. `undefined` means "declared, but not as a literal we can read" —
   * a caller must not report that as "no policy".
   */
  agentPolicy: string | null | undefined;
  /**
   * Named middleware, or `undefined` when declared as something other than an
   * inline array of string literals. Distinguishing the two matters: reporting
   * an unreadable chain as `[]` says the capability is ungated.
   */
  middleware: string[] | undefined;
}

type StaticAnalysisNode = {
  type: string;
  [key: string]: unknown;
};

const UNRESOLVED_STATIC_BINDING = Symbol("unresolved-static-binding");

interface StaticBindingWrite {
  position: number;
  unconditional: boolean;
  value: unknown | typeof UNRESOLVED_STATIC_BINDING;
}

/**
 * Whether a parsed JavaScript/TypeScript module statically exposes a runtime
 * binding named `middleware`.
 *
 * Consumers parse with their own Vite/Oxc language mode and pass the resulting
 * ESTree-like program here. Keeping the classification shared prevents build
 * and CLI verification from accepting different middleware module shapes.
 */
export function hasNamedMiddlewareExport(program: unknown): boolean {
  const root = asStaticAnalysisNode(program);
  if (!root) return false;

  const bindingWrites = collectTopLevelBindingWrites(root);
  const { knownNonCallableBindings, runtimeBindings } = collectTopLevelBindingKinds(
    root,
    bindingWrites,
  );
  let hasExplicitMiddlewareExport = false;
  let hasValueStarExport = false;

  for (const statement of nodeArray(root.body)) {
    if (statement.type === "ExportAllDeclaration") {
      // `export type *` has no runtime bindings, while
      // `export * as middleware` exposes a namespace object rather than the
      // required function. Only an ordinary value `export * from` can
      // conservatively re-export a working middleware binding.
      if (statement.exportKind === "type") continue;
      if (statement.exported) {
        if (getStaticIdentifierName(statement.exported) === "middleware") {
          hasExplicitMiddlewareExport = true;
        }
        continue;
      }
      hasValueStarExport = true;
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    const declaration = asStaticAnalysisNode(statement.declaration);
    if (declaration?.type === "FunctionDeclaration") {
      if (getStaticIdentifierName(declaration.id) === "middleware") {
        hasExplicitMiddlewareExport = true;
        if (
          !isBindingKnownNonCallableAt(
            "middleware",
            Number.POSITIVE_INFINITY,
            knownNonCallableBindings,
            bindingWrites,
          )
        ) {
          return true;
        }
      }
    } else if (declaration?.type === "TSImportEqualsDeclaration") {
      if (
        declaration.importKind !== "type" &&
        getStaticIdentifierName(declaration.id) === "middleware"
      ) {
        hasExplicitMiddlewareExport = true;
        return true;
      }
    } else if (declaration?.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of nodeArray(declaration.declarations)) {
        if (!collectStaticBindingNames(declarator.id).includes("middleware")) continue;
        hasExplicitMiddlewareExport = true;
        if (
          isBindingKnownNonCallableAt(
            "middleware",
            Number.POSITIVE_INFINITY,
            knownNonCallableBindings,
            bindingWrites,
          )
        ) {
          continue;
        }
        return true;
      }
    } else if (
      declaration &&
      declaration.declare !== true &&
      (declaration.type === "ClassDeclaration" ||
        declaration.type === "TSEnumDeclaration" ||
        declaration.type === "TSModuleDeclaration") &&
      getStaticIdentifierName(declaration.id) === "middleware"
    ) {
      hasExplicitMiddlewareExport = true;
    }

    for (const specifier of nodeArray(statement.specifiers)) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
      if (getStaticIdentifierName(specifier.exported) !== "middleware") continue;
      hasExplicitMiddlewareExport = true;

      // A re-export from another module cannot be resolved without loading it;
      // preserve working value barrels and let runtime validation fail closed.
      if (statement.source) return true;

      const localName = getStaticIdentifierName(specifier.local);
      if (
        !localName ||
        !runtimeBindings.has(localName) ||
        isBindingKnownNonCallableAt(
          localName,
          Number.POSITIVE_INFINITY,
          knownNonCallableBindings,
          bindingWrites,
        )
      ) {
        continue;
      }
      return true;
    }
  }

  // Explicit exports take precedence over star exports in ESM. A known-bad
  // explicit `middleware` therefore cannot be rescued by an unrelated
  // `export *`, while a module with only a value star remains conservative.
  return !hasExplicitMiddlewareExport && hasValueStarExport;
}

function collectTopLevelBindingKinds(
  program: StaticAnalysisNode,
  bindingWrites: ReadonlyMap<string, readonly StaticBindingWrite[]>,
): {
  knownNonCallableBindings: Set<string>;
  runtimeBindings: Set<string>;
  typeOnlyBindings: Set<string>;
} {
  const knownNonCallableBindings = new Set<string>();
  const runtimeBindings = new Set<string>();
  const typeOnlyBindings = new Set<string>();
  const bindingInitializers = new Map<string, unknown>();
  const callableFunctionBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  for (const rawStatement of nodeArray(program.body)) {
    if (rawStatement.type === "ImportDeclaration") {
      for (const specifier of nodeArray(rawStatement.specifiers)) {
        const name = getStaticIdentifierName(specifier.local);
        if (!name) continue;
        if (rawStatement.importKind === "type" || specifier.importKind === "type") {
          typeOnlyBindings.add(name);
        } else {
          runtimeBindings.add(name);
          // A module namespace is always an object, never the callable
          // middleware value required by the runtime contract.
          if (specifier.type === "ImportNamespaceSpecifier") {
            knownNonCallableBindings.add(name);
          }
        }
      }
      continue;
    }

    const statement =
      rawStatement.type === "ExportNamedDeclaration"
        ? asStaticAnalysisNode(rawStatement.declaration)
        : rawStatement;
    if (!statement) continue;

    if (statement.type === "TSImportEqualsDeclaration") {
      const name = getStaticIdentifierName(statement.id);
      if (name) {
        if (statement.importKind === "type") typeOnlyBindings.add(name);
        else runtimeBindings.add(name);
      }
      continue;
    }

    if (
      statement.type === "TSTypeAliasDeclaration" ||
      statement.type === "TSInterfaceDeclaration"
    ) {
      const name = getStaticIdentifierName(statement.id);
      if (name) typeOnlyBindings.add(name);
      continue;
    }

    if (statement.type === "TSDeclareFunction" || statement.declare === true) {
      if (statement.type === "VariableDeclaration") {
        for (const declarator of nodeArray(statement.declarations)) {
          for (const name of collectStaticBindingNames(declarator.id)) {
            typeOnlyBindings.add(name);
          }
        }
      } else {
        const name = getStaticIdentifierName(statement.id);
        if (name) typeOnlyBindings.add(name);
      }
      continue;
    }

    if (statement.type === "VariableDeclaration") {
      for (const declarator of nodeArray(statement.declarations)) {
        const names = collectStaticBindingNames(declarator.id);
        for (const name of names) runtimeBindings.add(name);
        for (const name of names) {
          const initializer = resolveStaticBindingInitializer(declarator.id, declarator.init, name);
          if (initializer !== UNRESOLVED_STATIC_BINDING) {
            bindingInitializers.set(name, initializer);
            if (isStaticallyNonCallable(initializer)) {
              knownNonCallableBindings.add(name);
            }
          }
        }
      }
      continue;
    }

    if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "TSEnumDeclaration" ||
      statement.type === "TSModuleDeclaration"
    ) {
      const name = getStaticIdentifierName(statement.id);
      if (name) {
        runtimeBindings.add(name);
        if (statement.type === "FunctionDeclaration") {
          callableFunctionBindings.add(name);
        } else if (statement.type === "TSModuleDeclaration") {
          // A namespace can declaration-merge with a function. The emitted
          // binding remains callable in that case, with the namespace values
          // attached as properties.
          namespaceBindings.add(name);
        } else {
          knownNonCallableBindings.add(name);
        }
      }
    }
  }

  for (const name of namespaceBindings) {
    if (!callableFunctionBindings.has(name)) knownNonCallableBindings.add(name);
  }

  // Propagate through local aliases after collecting the whole module so
  // declaration order and multi-hop chains do not matter. Dynamic values stay
  // unresolved, while aliases of literals, classes, enums, namespaces, and
  // other values already proven non-callable remain just as provable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of bindingInitializers) {
      if (knownNonCallableBindings.has(name)) continue;
      const referencedName = getStaticReferencedBindingName(initializer);
      if (!referencedName) continue;
      const initializerNode = asStaticAnalysisNode(initializer);
      const initializerStart =
        initializerNode && typeof initializerNode.start === "number"
          ? initializerNode.start
          : Number.POSITIVE_INFINITY;
      if (
        !isBindingKnownNonCallableAt(
          referencedName,
          initializerStart,
          knownNonCallableBindings,
          bindingWrites,
        )
      ) {
        continue;
      }
      knownNonCallableBindings.add(name);
      changed = true;
    }
  }

  return { knownNonCallableBindings, runtimeBindings, typeOnlyBindings };
}

/**
 * A top-level write can replace a binding before the module is imported. Keep
 * the writes in runtime evaluation order so direct exports use the final value
 * while local aliases use the value that existed when their initializer ran.
 */
function collectTopLevelBindingWrites(
  program: StaticAnalysisNode,
): Map<string, StaticBindingWrite[]> {
  const writes = new Map<string, StaticBindingWrite[]>();

  for (const statement of nodeArray(program.body)) {
    const unconditionalExpressions = new Set<StaticAnalysisNode>();
    collectUnconditionallyEvaluatedStatement(statement, unconditionalExpressions);
    collectTopLevelBindingWritesFromNode(statement, writes, unconditionalExpressions, new Set());
  }

  return writes;
}

function collectTopLevelBindingWritesFromNode(
  value: unknown,
  writes: Map<string, StaticBindingWrite[]>,
  unconditionalExpressions: ReadonlySet<StaticAnalysisNode>,
  shadowedBindings: ReadonlySet<string>,
): void {
  const node = asStaticAnalysisNode(value);
  if (!node) return;

  if (
    node.type === "FunctionDeclaration" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  ) {
    return;
  }

  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectTopLevelBindingWritesFromClass(node, writes, unconditionalExpressions, shadowedBindings);
    return;
  }

  if (node.type === "BlockStatement" || node.type === "StaticBlock") {
    const blockBindings = collectLexicalStatementBindings(nodeArray(node.body));
    const blockShadowed = new Set([...shadowedBindings, ...blockBindings]);
    for (const statement of nodeArray(node.body)) {
      collectTopLevelBindingWritesFromNode(
        statement,
        writes,
        unconditionalExpressions,
        blockShadowed,
      );
    }
    return;
  }

  if (node.type === "CatchClause") {
    const catchShadowed = new Set([...shadowedBindings, ...collectStaticBindingNames(node.param)]);
    collectTopLevelBindingWritesFromNode(
      node.body,
      writes,
      unconditionalExpressions,
      catchShadowed,
    );
    return;
  }

  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    const declaration = asStaticAnalysisNode(node.init ?? node.left);
    const loopBindings =
      declaration?.type === "VariableDeclaration" && declaration.kind !== "var"
        ? nodeArray(declaration.declarations).flatMap((declarator) =>
            collectStaticBindingNames(declarator.id),
          )
        : [];
    const loopShadowed = new Set([...shadowedBindings, ...loopBindings]);
    for (const key of ["init", "left", "right", "test", "update", "body"]) {
      collectTopLevelBindingWritesFromNode(
        node[key],
        writes,
        unconditionalExpressions,
        loopShadowed,
      );
    }
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "loc" || key === "span") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        collectTopLevelBindingWritesFromNode(
          item,
          writes,
          unconditionalExpressions,
          shadowedBindings,
        );
      }
    } else {
      collectTopLevelBindingWritesFromNode(
        child,
        writes,
        unconditionalExpressions,
        shadowedBindings,
      );
    }
  }

  // Assignment targets are written after their right-hand side is evaluated.
  // Record the write after descending so nested assignments keep that runtime
  // order instead of the AST's outer-before-inner source order.
  if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
    const start = typeof node.start === "number" ? node.start : Number.NEGATIVE_INFINITY;
    const target = node.type === "AssignmentExpression" ? node.left : node.argument;
    for (const name of collectStaticBindingNames(target)) {
      if (shadowedBindings.has(name)) continue;
      const bindingWrites = writes.get(name) ?? [];
      bindingWrites.push({
        position: start,
        unconditional: unconditionalExpressions.has(node),
        value: resolveStaticBindingWriteValue(node, name),
      });
      writes.set(name, bindingWrites);
    }
  }
}

function collectLexicalStatementBindings(statements: readonly StaticAnalysisNode[]): string[] {
  const bindings: string[] = [];

  for (const rawStatement of statements) {
    const statement =
      rawStatement.type === "ExportNamedDeclaration"
        ? asStaticAnalysisNode(rawStatement.declaration)
        : rawStatement;
    if (!statement) continue;

    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      for (const declarator of nodeArray(statement.declarations)) {
        bindings.push(...collectStaticBindingNames(declarator.id));
      }
    } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      const name = getStaticIdentifierName(statement.id);
      if (name) bindings.push(name);
    }
  }

  return bindings;
}

function collectUnconditionallyEvaluatedStatement(
  statement: StaticAnalysisNode,
  expressions: Set<StaticAnalysisNode>,
): void {
  if (statement.type === "ExpressionStatement") {
    collectUnconditionallyEvaluatedExpressions(statement.expression, expressions);
    return;
  }

  if (statement.type === "VariableDeclaration") {
    for (const declarator of nodeArray(statement.declarations)) {
      collectUnconditionallyEvaluatedExpressions(declarator.init, expressions);
    }
    return;
  }

  if (statement.type === "ExportNamedDeclaration") {
    const declaration = asStaticAnalysisNode(statement.declaration);
    if (declaration) collectUnconditionallyEvaluatedStatement(declaration, expressions);
    return;
  }

  if (statement.type === "ExportDefaultDeclaration") {
    const declaration = asStaticAnalysisNode(statement.declaration);
    if (!declaration) return;
    if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
      collectClassEvaluationExpressions(declaration, expressions);
    } else if (declaration.type !== "FunctionDeclaration") {
      collectUnconditionallyEvaluatedExpressions(declaration, expressions);
    }
    return;
  }

  if (statement.type === "ClassDeclaration") {
    collectClassEvaluationExpressions(statement, expressions);
    return;
  }

  if (statement.type === "BlockStatement" || statement.type === "StaticBlock") {
    for (const child of nodeArray(statement.body)) {
      collectUnconditionallyEvaluatedStatement(child, expressions);
    }
    return;
  }

  if (
    statement.type === "IfStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "SwitchStatement" ||
    statement.type === "WithStatement"
  ) {
    collectUnconditionallyEvaluatedExpressions(
      statement.test ?? statement.discriminant ?? statement.object,
      expressions,
    );
    return;
  }

  if (statement.type === "ForStatement") {
    const initializer = asStaticAnalysisNode(statement.init);
    if (initializer?.type === "VariableDeclaration") {
      collectUnconditionallyEvaluatedStatement(initializer, expressions);
    } else {
      collectUnconditionallyEvaluatedExpressions(initializer, expressions);
    }
    collectUnconditionallyEvaluatedExpressions(statement.test, expressions);
    return;
  }

  if (statement.type === "ForInStatement" || statement.type === "ForOfStatement") {
    collectUnconditionallyEvaluatedExpressions(statement.right, expressions);
    return;
  }

  if (statement.type === "DoWhileStatement") {
    const body = asStaticAnalysisNode(statement.body);
    const completesBody = body ? collectDefinitelyEnteredStatement(body, expressions) : false;
    if (completesBody) {
      collectUnconditionallyEvaluatedExpressions(statement.test, expressions);
    }
    return;
  }

  if (statement.type === "LabeledStatement") {
    const body = asStaticAnalysisNode(statement.body);
    if (body) collectDefinitelyEnteredStatement(body, expressions);
    return;
  }

  if (statement.type === "TryStatement") {
    // Without a catch, every successful module evaluation entered the try
    // body. A catch can turn an earlier throw into a successful path that
    // skips later statements, so keep that body conservative. The finalizer
    // is evaluated on every path that leaves either branch.
    if (!statement.handler) {
      const block = asStaticAnalysisNode(statement.block);
      if (block) collectUnconditionallyEvaluatedStatement(block, expressions);
    }
    const finalizer = asStaticAnalysisNode(statement.finalizer);
    if (finalizer) collectUnconditionallyEvaluatedStatement(finalizer, expressions);
    return;
  }
}

/**
 * Collect the straight-line prefix of a statement that is guaranteed to run
 * after its parent has been entered. Returning false stops callers before a
 * possible break/continue/branch makes the rest conditional.
 */
function collectDefinitelyEnteredStatement(
  statement: StaticAnalysisNode,
  expressions: Set<StaticAnalysisNode>,
): boolean {
  if (statement.type === "BlockStatement" || statement.type === "StaticBlock") {
    for (const child of nodeArray(statement.body)) {
      if (!collectDefinitelyEnteredStatement(child, expressions)) return false;
    }
    return true;
  }

  if (statement.type === "LabeledStatement") {
    const body = asStaticAnalysisNode(statement.body);
    return body ? collectDefinitelyEnteredStatement(body, expressions) : false;
  }

  if (
    statement.type === "ExpressionStatement" ||
    statement.type === "VariableDeclaration" ||
    statement.type === "ClassDeclaration" ||
    statement.type === "FunctionDeclaration" ||
    statement.type === "EmptyStatement" ||
    statement.type === "DebuggerStatement"
  ) {
    collectUnconditionallyEvaluatedStatement(statement, expressions);
    return true;
  }

  if (
    statement.type === "IfStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "SwitchStatement" ||
    statement.type === "WithStatement" ||
    statement.type === "ForStatement" ||
    statement.type === "ForInStatement" ||
    statement.type === "ForOfStatement" ||
    statement.type === "DoWhileStatement" ||
    statement.type === "TryStatement"
  ) {
    collectUnconditionallyEvaluatedStatement(statement, expressions);
  }

  return false;
}

function collectClassEvaluationExpressions(
  classNode: StaticAnalysisNode,
  expressions: Set<StaticAnalysisNode>,
): void {
  for (const decorator of nodeArray(classNode.decorators)) {
    collectUnconditionallyEvaluatedExpressions(decorator.expression ?? decorator, expressions);
  }
  collectUnconditionallyEvaluatedExpressions(classNode.superClass, expressions);

  const body = asStaticAnalysisNode(classNode.body);
  for (const element of nodeArray(body?.body)) {
    for (const decorator of nodeArray(element.decorators)) {
      collectUnconditionallyEvaluatedExpressions(decorator.expression ?? decorator, expressions);
    }
    if (element.computed === true) {
      collectUnconditionallyEvaluatedExpressions(element.key, expressions);
    }
    if (element.type === "PropertyDefinition" && element.static === true) {
      collectUnconditionallyEvaluatedExpressions(element.value, expressions);
    } else if (element.type === "StaticBlock") {
      collectUnconditionallyEvaluatedStatement(element, expressions);
    }
  }
}

function collectTopLevelBindingWritesFromClass(
  classNode: StaticAnalysisNode,
  writes: Map<string, StaticBindingWrite[]>,
  unconditionalExpressions: ReadonlySet<StaticAnalysisNode>,
  shadowedBindings: ReadonlySet<string>,
): void {
  const className = getStaticIdentifierName(classNode.id);
  const classShadowed = className ? new Set([...shadowedBindings, className]) : shadowedBindings;
  for (const decorator of nodeArray(classNode.decorators)) {
    collectTopLevelBindingWritesFromNode(
      decorator.expression ?? decorator,
      writes,
      unconditionalExpressions,
      shadowedBindings,
    );
  }
  collectTopLevelBindingWritesFromNode(
    classNode.superClass,
    writes,
    unconditionalExpressions,
    shadowedBindings,
  );

  const body = asStaticAnalysisNode(classNode.body);
  for (const element of nodeArray(body?.body)) {
    for (const decorator of nodeArray(element.decorators)) {
      collectTopLevelBindingWritesFromNode(
        decorator.expression ?? decorator,
        writes,
        unconditionalExpressions,
        classShadowed,
      );
    }
    if (element.computed === true) {
      collectTopLevelBindingWritesFromNode(
        element.key,
        writes,
        unconditionalExpressions,
        classShadowed,
      );
    }
    if (element.type === "PropertyDefinition" && element.static === true) {
      collectTopLevelBindingWritesFromNode(
        element.value,
        writes,
        unconditionalExpressions,
        classShadowed,
      );
    } else if (element.type === "StaticBlock") {
      collectTopLevelBindingWritesFromNode(
        element,
        writes,
        unconditionalExpressions,
        classShadowed,
      );
    }
  }
}

function collectUnconditionallyEvaluatedExpressions(
  value: unknown,
  expressions: Set<StaticAnalysisNode>,
): void {
  const node = asStaticAnalysisNode(value);
  if (!node) return;
  expressions.add(node);

  if (
    node.type === "FunctionDeclaration" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  ) {
    return;
  }

  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectClassEvaluationExpressions(node, expressions);
    return;
  }

  if (node.type === "AssignmentExpression") {
    collectAssignmentTargetEvaluation(node.left, expressions);
    if (node.operator !== "&&=" && node.operator !== "||=" && node.operator !== "??=") {
      collectUnconditionallyEvaluatedExpressions(node.right, expressions);
    }
    return;
  }

  if (node.type === "UpdateExpression") {
    collectAssignmentTargetEvaluation(node.argument, expressions);
    return;
  }

  if (node.type === "LogicalExpression") {
    collectUnconditionallyEvaluatedExpressions(node.left, expressions);
    return;
  }

  if (node.type === "ConditionalExpression") {
    collectUnconditionallyEvaluatedExpressions(node.test, expressions);
    return;
  }

  if (node.type === "ChainExpression") {
    collectOptionalChainPrefix(node.expression, expressions);
    return;
  }

  if (node.type === "CallExpression") {
    collectUnconditionallyEvaluatedExpressions(node.callee, expressions);
    if (node.optional !== true) {
      for (const argument of nodeArray(node.arguments)) {
        collectUnconditionallyEvaluatedExpressions(argument, expressions);
      }
    }
    return;
  }

  if (node.type === "MemberExpression") {
    collectUnconditionallyEvaluatedExpressions(node.object, expressions);
    if (node.computed === true && node.optional !== true) {
      collectUnconditionallyEvaluatedExpressions(node.property, expressions);
    }
    return;
  }

  // For every other expression shape (sequences, unary/binary expressions,
  // arrays, objects, templates, non-optional `new`, JSX containers, and
  // transparent TypeScript wrappers), child expressions are evaluated when
  // their parent is. The control-flow shapes above handle their conditional
  // branches explicitly before this generic traversal.
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "loc" || key === "span") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        collectUnconditionallyEvaluatedExpressions(item, expressions);
      }
    } else {
      collectUnconditionallyEvaluatedExpressions(child, expressions);
    }
  }
}

function collectOptionalChainPrefix(value: unknown, expressions: Set<StaticAnalysisNode>): void {
  const node = asStaticAnalysisNode(value);
  if (!node) return;
  expressions.add(node);

  if (node.type === "CallExpression") {
    if (node.optional === true || hasOptionalChainSegment(node.callee)) {
      collectOptionalChainPrefix(node.callee, expressions);
      return;
    }
  } else if (node.type === "MemberExpression") {
    if (node.optional === true || hasOptionalChainSegment(node.object)) {
      collectOptionalChainPrefix(node.object, expressions);
      return;
    }
  }

  collectUnconditionallyEvaluatedExpressions(node, expressions);
}

function hasOptionalChainSegment(value: unknown): boolean {
  const node = asStaticAnalysisNode(value);
  if (!node) return false;
  if (node.type === "ChainExpression") return hasOptionalChainSegment(node.expression);
  if (node.type === "CallExpression") {
    return node.optional === true || hasOptionalChainSegment(node.callee);
  }
  if (node.type === "MemberExpression") {
    return node.optional === true || hasOptionalChainSegment(node.object);
  }
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TypeCastExpression"
  ) {
    return hasOptionalChainSegment(node.expression);
  }
  return false;
}

function collectAssignmentTargetEvaluation(
  value: unknown,
  expressions: Set<StaticAnalysisNode>,
): void {
  let node = asStaticAnalysisNode(value);
  while (
    node &&
    (node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSTypeAssertion" ||
      node.type === "TypeCastExpression")
  ) {
    expressions.add(node);
    node = asStaticAnalysisNode(node.expression);
  }

  // Member targets and computed destructuring keys have subexpressions that
  // run while resolving the assignment target. Destructuring defaults remain
  // conditional on the assigned value and therefore only recurse into their
  // left-hand target here.
  if (node?.type === "MemberExpression") {
    collectUnconditionallyEvaluatedExpressions(node, expressions);
  } else if (node?.type === "ObjectPattern") {
    for (const property of nodeArray(node.properties)) {
      if (property.type === "RestElement") {
        collectAssignmentTargetEvaluation(property.argument, expressions);
        continue;
      }
      if (property.computed === true) {
        collectUnconditionallyEvaluatedExpressions(property.key, expressions);
      }
      collectAssignmentTargetEvaluation(property.value, expressions);
    }
  } else if (node?.type === "ArrayPattern") {
    for (const element of nodeArray(node.elements)) {
      collectAssignmentTargetEvaluation(element, expressions);
    }
  } else if (node?.type === "AssignmentPattern") {
    collectAssignmentTargetEvaluation(node.left, expressions);
  } else if (node?.type === "RestElement") {
    collectAssignmentTargetEvaluation(node.argument, expressions);
  }
}

function resolveStaticBindingWriteValue(
  node: StaticAnalysisNode,
  bindingName: string,
): unknown | typeof UNRESOLVED_STATIC_BINDING {
  if (node.type === "UpdateExpression") return { type: "UpdateExpression" };
  if (node.type !== "AssignmentExpression") return UNRESOLVED_STATIC_BINDING;

  if (node.operator === "=") {
    return resolveStaticBindingInitializer(node.left, node.right, bindingName);
  }

  if (node.operator === "&&=" || node.operator === "||=" || node.operator === "??=") {
    return UNRESOLVED_STATIC_BINDING;
  }

  return { type: "BinaryExpression" };
}

function isBindingKnownNonCallableAt(
  name: string,
  position: number,
  knownNonCallableBindings: ReadonlySet<string>,
  bindingWrites: ReadonlyMap<string, readonly StaticBindingWrite[]>,
): boolean {
  const latestWrite = bindingWrites
    .get(name)
    ?.filter((write) => write.position < position)
    .at(-1);
  if (!latestWrite) return knownNonCallableBindings.has(name);
  if (!latestWrite.unconditional || latestWrite.value === UNRESOLVED_STATIC_BINDING) return false;
  return isStaticallyNonCallable(latestWrite.value);
}

function getStaticReferencedBindingName(value: unknown): string | null {
  let node = asStaticAnalysisNode(value);
  if (!node) return null;

  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TypeCastExpression"
  ) {
    const expression = asStaticAnalysisNode(node.expression);
    if (!expression) return null;
    node = expression;
  }

  return node.type === "Identifier" ? getStaticIdentifierName(node) : null;
}

/**
 * Resolve a binding's value when a literal destructuring initializer makes it
 * unambiguous. Dynamic objects stay unresolved so valid middleware factories
 * and imported registries are still accepted conservatively.
 */
function resolveStaticBindingInitializer(
  patternValue: unknown,
  initializerValue: unknown,
  bindingName: string,
): unknown | typeof UNRESOLVED_STATIC_BINDING {
  const pattern = asStaticAnalysisNode(patternValue);
  if (!pattern) return UNRESOLVED_STATIC_BINDING;

  if (pattern.type === "Identifier") {
    return getStaticIdentifierName(pattern) === bindingName
      ? initializerValue
      : UNRESOLVED_STATIC_BINDING;
  }

  if (pattern.type === "AssignmentPattern") {
    const initializer = resolveStaticBindingInitializer(
      pattern.left,
      initializerValue,
      bindingName,
    );
    if (initializer === UNRESOLVED_STATIC_BINDING) return initializer;
    return isStaticallyUndefined(initializer) ? pattern.right : initializer;
  }

  if (pattern.type === "ArrayPattern") {
    const initializer = asStaticAnalysisNode(initializerValue);
    if (initializer?.type !== "ArrayExpression") return UNRESOLVED_STATIC_BINDING;
    const patternElements = unknownArray(pattern.elements);
    const initializerElements = unknownArray(initializer.elements);
    for (const [index, element] of patternElements.entries()) {
      if (!collectStaticBindingNames(element).includes(bindingName)) continue;
      const elementNode = asStaticAnalysisNode(element);
      if (elementNode?.type === "RestElement") return { type: "ArrayExpression" };
      return resolveStaticBindingInitializer(element, initializerElements[index], bindingName);
    }
    return UNRESOLVED_STATIC_BINDING;
  }

  if (pattern.type === "ObjectPattern") {
    const initializer = asStaticAnalysisNode(initializerValue);
    if (initializer?.type !== "ObjectExpression") return UNRESOLVED_STATIC_BINDING;
    for (const property of nodeArray(pattern.properties)) {
      const bindingPattern = property.type === "RestElement" ? property.argument : property.value;
      if (!collectStaticBindingNames(bindingPattern).includes(bindingName)) continue;
      if (property.type === "RestElement") return { type: "ObjectExpression" };
      if (property.type !== "Property" || property.computed === true) {
        return UNRESOLVED_STATIC_BINDING;
      }
      const key = getStaticIdentifierName(property.key);
      if (!key) return UNRESOLVED_STATIC_BINDING;
      const propertyInitializer = resolveStaticObjectProperty(initializer, key);
      if (propertyInitializer === UNRESOLVED_STATIC_BINDING) return propertyInitializer;
      return resolveStaticBindingInitializer(property.value, propertyInitializer, bindingName);
    }
  }

  return UNRESOLVED_STATIC_BINDING;
}

function resolveStaticObjectProperty(
  object: StaticAnalysisNode,
  key: string,
): unknown | typeof UNRESOLVED_STATIC_BINDING {
  const properties = nodeArray(object.properties);
  for (let index = properties.length - 1; index >= 0; index -= 1) {
    const property = properties[index];
    if (property.type !== "Property" || property.computed === true) {
      // A later spread or computed key may overwrite the requested property.
      return UNRESOLVED_STATIC_BINDING;
    }
    if (getStaticIdentifierName(property.key) !== key) continue;
    if (property.kind === "get") return UNRESOLVED_STATIC_BINDING;
    if (property.kind !== "set") return property.value;

    // Reading a setter-only property produces `undefined`. A preceding getter
    // for the same key forms an accessor pair, whose value is runtime-defined.
    for (let accessorIndex = index - 1; accessorIndex >= 0; accessorIndex -= 1) {
      const accessor = properties[accessorIndex];
      if (accessor.type !== "Property" || accessor.computed === true) {
        return UNRESOLVED_STATIC_BINDING;
      }
      if (getStaticIdentifierName(accessor.key) !== key) continue;
      if (accessor.kind === "get") return UNRESOLVED_STATIC_BINDING;
      if (accessor.kind !== "set") return undefined;
    }
    return undefined;
  }
  // A literal object with no spreads or computed keys has an `undefined`
  // value for a missing property.
  return undefined;
}

function isStaticallyUndefined(value: unknown): boolean {
  const node = asStaticAnalysisNode(value);
  if (!node) return true;
  if (node.type === "Identifier") return getStaticIdentifierName(node) === "undefined";
  return node.type === "UnaryExpression" && node.operator === "void";
}

/** Reject only expressions whose runtime value is unambiguously not callable. */
function isStaticallyNonCallable(value: unknown): boolean {
  let node = asStaticAnalysisNode(value);
  if (!node) return true;

  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TypeCastExpression"
  ) {
    const expression = asStaticAnalysisNode(node.expression);
    if (!expression) return true;
    node = expression;
  }

  if (node.type === "Identifier") return getStaticIdentifierName(node) === "undefined";

  return new Set([
    "ArrayExpression",
    "BigIntLiteral",
    "BinaryExpression",
    "BooleanLiteral",
    "ClassExpression",
    "ImportExpression",
    "JSXElement",
    "JSXFragment",
    "Literal",
    "MetaProperty",
    "NullLiteral",
    "NumericLiteral",
    "ObjectExpression",
    "RegExpLiteral",
    "StringLiteral",
    "TemplateLiteral",
    "UnaryExpression",
    "UpdateExpression",
  ]).has(node.type);
}

function collectStaticBindingNames(pattern: unknown): string[] {
  const node = asStaticAnalysisNode(pattern);
  if (!node) return [];

  if (node.type === "Identifier") {
    const name = getStaticIdentifierName(node);
    return name ? [name] : [];
  }
  if (node.type === "RestElement" || node.type === "AssignmentPattern") {
    return collectStaticBindingNames(node.argument ?? node.left);
  }
  if (node.type === "ArrayPattern") {
    return unknownArray(node.elements).flatMap(collectStaticBindingNames);
  }
  if (node.type === "ObjectPattern") {
    return nodeArray(node.properties).flatMap((property) => {
      if (property.type === "RestElement") return collectStaticBindingNames(property.argument);
      return collectStaticBindingNames(property.value);
    });
  }
  return [];
}

function getStaticIdentifierName(value: unknown): string | null {
  const node = asStaticAnalysisNode(value);
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return typeof node.name === "string" ? node.name : null;
  }
  if (node.type === "Literal" || node.type === "StringLiteral") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
}

function asStaticAnalysisNode(value: unknown): StaticAnalysisNode | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (value as StaticAnalysisNode) : null;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nodeArray(value: unknown): StaticAnalysisNode[] {
  return unknownArray(value).flatMap((entry) => {
    const node = asStaticAnalysisNode(entry);
    return node ? [node] : [];
  });
}

/**
 * Derive a capability's projection from its source, without executing it.
 *
 * This is the single implementation behind three consumers that must agree:
 * the Vite plugin builds the browser endpoint table from it, `pracht verify`
 * checks the contract against it, and `pracht typegen` cross-checks it against
 * the executed graph. If they disagreed, generated types could promise an
 * endpoint the client bundle never registered.
 *
 * `name` supplies the default HTTP path; `describe` wraps error messages so
 * each caller can phrase them its own way (the plugin fails the build, the CLI
 * fails a check).
 */
export function extractCapabilityProjection(
  name: string,
  source: string,
  describe: (detail: string) => string,
): CapabilityProjection {
  const args = extractDefineCapabilityArgs(source);
  if (!args) {
    throw new Error(
      describe("does not contain a defineCapability({ ... }) call the build can analyze."),
    );
  }

  const { properties, truncated } = scanTopLevelPropertyEntries(args);
  const exposeText = properties.get("expose");
  // A truncated scan cannot tell "no `expose`" from "`expose` sat after the
  // token we could not parse". Treating that as private would commit an
  // http+mcp-exposed capability to the graph as unreachable, so refuse instead
  // — which is also what the documented contract says a spread does.
  if (!exposeText && truncated) {
    throw new Error(
      describe(
        "contains a spread or computed key the build cannot analyze, so its `expose` could not be " +
          "read. Declare `expose`, `effect`, `agentPolicy`, and `middleware` as inline literals.",
      ),
    );
  }
  if (!exposeText) {
    // Private capability: server-only, nothing to project to the client.
    return {
      description: "",
      effect: null,
      httpPath: null,
      webmcp: false,
      inputSchema: null,
      mcp: false,
      ...readGuardProperties(properties, truncated),
    };
  }

  const expose = evaluateLiteral(exposeText);
  if (!isPlainObject(expose)) {
    throw new Error(
      describe(
        '"expose" must be an inline object literal so the client projection can be generated at build time.',
      ),
    );
  }

  const http = expose.http;
  let httpPath: string | null = null;
  if (http === true) {
    httpPath = capabilityHttpPath(name);
  } else if (isPlainObject(http)) {
    httpPath = typeof http.path === "string" ? http.path : capabilityHttpPath(name);
  }
  if (httpPath && !isValidCapabilityHttpPath(httpPath)) {
    throw new Error(
      describe('HTTP exposure "path" must be an exact same-origin pathname starting with "/".'),
    );
  }

  const webmcp = expose.webmcp === true;
  if (webmcp && !httpPath) {
    throw new Error(describe("expose.webmcp requires expose.http."));
  }

  let description = "";
  const descriptionText = properties.get("description");
  if (descriptionText) {
    const value = evaluateLiteral(descriptionText);
    if (typeof value === "string") description = value;
  }

  let effect: string | null = null;
  const effectText = properties.get("effect");
  if (effectText) {
    const value = evaluateLiteral(effectText);
    if (typeof value === "string") effect = value;
  }
  if (httpPath && effect !== "read" && effect !== "write" && effect !== "destructive") {
    throw new Error(
      describe(
        'is exposed via HTTP, but its "effect" could not be extracted at build time. ' +
          'HTTP-exposed capabilities must declare "effect" as an inline "read", "write", or ' +
          '"destructive" string literal.',
      ),
    );
  }

  let inputSchema: Record<string, unknown> | null = null;
  if (webmcp) {
    const inputText = properties.get("input");
    const value = inputText ? evaluateLiteral(inputText) : undefined;
    if (!isPlainObject(value)) {
      throw new Error(
        describe(
          'is exposed via WebMCP, but its "input" schema could not be extracted at build time. ' +
            "WebMCP-exposed capabilities must declare their input schema as an inline object literal.",
        ),
      );
    }
    inputSchema = value;
  }

  return {
    description,
    effect,
    httpPath,
    webmcp,
    inputSchema,
    mcp: expose.mcp === true,
    ...readGuardProperties(properties, truncated),
  };
}

/**
 * Recover the guard-shaped fields — the ones a reviewer reads to decide whether
 * a change widened what agents can reach.
 *
 * Each is `undefined` when it is declared but not as a literal this pass can
 * evaluate, so a caller can say "unverifiable" rather than "absent". `null`
 * `agentPolicy` and `[]` middleware are real answers meaning "not declared".
 */
function readGuardProperties(
  properties: Map<string, string>,
  truncated: boolean,
): Pick<CapabilityProjection, "agentPolicy" | "middleware"> {
  // After a truncated scan an absent key means "not seen", not "not declared".
  // Reporting `null` / `[]` there is the fail-open case: a capability whose
  // guards arrive via `...gated` would read as ungated, with everything else
  // correct, so the entry looks like a verified contract.
  if (truncated) return { agentPolicy: undefined, middleware: undefined };

  const policyText = properties.get("agentPolicy");
  let agentPolicy: string | null | undefined = null;
  if (policyText) {
    const value = evaluateLiteral(policyText);
    agentPolicy = typeof value === "string" ? value : undefined;
  }

  const middlewareText = properties.get("middleware");
  let middleware: string[] | undefined = [];
  if (middlewareText) {
    const value = evaluateLiteral(middlewareText);
    middleware =
      Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : undefined;
  }

  return { agentPolicy, middleware };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the argument object text of the *default-exported*
 * `defineCapability({ ... })` call. The runtime resolves a capability module
 * by its default export, so analysis must agree: a helper `defineCapability()`
 * call earlier in the file must not be mistaken for the exported one. Matches
 * the call site (optionally with a type argument), not the import binding.
 */
export function extractDefineCapabilityArgs(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const parenIndex = findDefaultExportedCallParen(searchable);
  if (parenIndex === -1) return null;
  const braceStart = searchable.indexOf("{", parenIndex);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

const CALL_SITE = /defineCapability\s*(?:<[^(]*?>)?\s*\(/g;

/**
 * Index of the `(` of the default-exported `defineCapability()` call, or -1
 * when the module has no analyzable default-exported call. Handles
 * `export default defineCapability(...)`, `export default <id>` (with or
 * without a trailing `;`), and `export { <id> as default }`, resolving the
 * identifier to its `const/let/var <id> = defineCapability(...)` declaration.
 * A named-only call is deliberately not accepted: the runtime requires the
 * capability itself to be the module's default export.
 */
function findDefaultExportedCallParen(searchable: string): number {
  const direct = /export\s+default\s+defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  if (direct && direct.index != null) {
    return direct.index + direct[0].length - 1;
  }

  const localName = defaultExportLocalName(searchable);
  if (localName) {
    const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`, "g");
    // The default export refers to the MODULE-scope binding; a shadowed
    // declaration inside a function must not win. Prefer the match at brace
    // depth 0.
    for (const match of searchable.matchAll(decl)) {
      if (match.index != null && braceDepthAt(searchable, match.index) === 0) {
        const paren = findDefineCapabilityInitializer(searchable, match.index + match[0].length);
        if (paren !== -1) return paren;
      }
    }
  }

  return -1;
}

/**
 * Resolve the first assignment of a variable declaration and accept it only
 * when its initializer is immediately `defineCapability(...)`. This avoids
 * crossing an ASI boundary into a later declaration while still supporting
 * multiline and arrow-function type annotations.
 */
function findDefineCapabilityInitializer(searchable: string, start: number): number {
  return findCallInitializer(searchable, start, "defineCapability", CALL_SITE.source);
}

function findCallInitializer(
  searchable: string,
  start: number,
  callName: string,
  callPattern = `${callName}\\s*(?:<[^(]*?>)?\\s*\\(`,
): number {
  let depth = 0;
  for (let index = start; index < searchable.length; index += 1) {
    const char = searchable[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return -1;
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === ";") return -1;
    if (char === "\n" || char === "\r") {
      const next = searchable.slice(skipWhitespace(searchable, index + 1));
      if (/^(?:(?:export|import)\b|(?:const|let|var|function|class)\b)/.test(next)) {
        return -1;
      }
      continue;
    }
    if (
      char === "=" &&
      searchable[index + 1] !== ">" &&
      searchable[index - 1] !== "=" &&
      searchable[index - 1] !== "!" &&
      searchable[index - 1] !== "<" &&
      searchable[index - 1] !== ">"
    ) {
      const initializerStart = skipWhitespace(searchable, index + 1);
      const call = new RegExp(`^${callPattern}`).exec(searchable.slice(initializerStart));
      return call ? initializerStart + call[0].length - 1 : -1;
    }
  }
  return -1;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/**
 * Brace/paren/bracket nesting depth at `index` in an already comment- and
 * string-masked source. Depth 0 means module scope.
 */
function braceDepthAt(searchable: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = searchable[cursor];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
  }
  return depth;
}

/** Local binding name of a module's default export, or null. */
function defaultExportLocalName(searchable: string): string | null {
  const idMatch = /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(searchable);
  if (idMatch && idMatch[1] !== "defineCapability") {
    return idMatch[1];
  }
  const asDefault = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default\b/.exec(
    searchable,
  );
  return asDefault ? asDefault[1] : null;
}

/**
 * Scan an object literal body for its top-level properties, returning a map
 * of property name → raw value text. Depth-aware and quote/comment-aware so
 * nested schema annotations (e.g. a `description` inside `input`) are never
 * mistaken for capability fields.
 */
export interface TopLevelPropertyScan {
  properties: Map<string, string>;
  /**
   * True when the scan hit a token it could not parse as a key (a spread, a
   * computed key) and stopped. Everything from that point on is missing from
   * `properties`, so a caller must not read an absent key as "not declared" —
   * that is how a spread-in `agentPolicy` or `middleware` came back as "no
   * policy, no middleware" instead of "unreadable".
   */
  truncated: boolean;
}

export function scanTopLevelProperties(objectBody: string): Map<string, string> {
  return scanTopLevelPropertyEntries(objectBody).properties;
}

export function scanTopLevelPropertyEntries(objectBody: string): TopLevelPropertyScan {
  const properties = new Map<string, string>();
  let index = 0;
  let truncated = false;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    // Property key: identifier, quoted string, or numeric literal. Registry
    // names use JavaScript's runtime property-key coercion, so an entry such as
    // `123: () => import(...)` has the string name `"123"`.
    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) {
        truncated = true;
        break;
      }
      const decoded = evaluateLiteral(objectBody.slice(index, end + 1));
      if (typeof decoded !== "string") {
        truncated = true;
        break;
      }
      key = decoded;
      index = end + 1;
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(objectBody[index + 1]))) {
      const parsed = parseNumericPropertyKey(objectBody, index);
      if (!parsed) {
        truncated = true;
        break;
      }
      key = parsed.key;
      index = parsed.index;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) {
        truncated = true;
        break;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      // Shorthand or method definitions — skip to the next top-level comma.
      index = skipToTopLevelComma(objectBody, index) + 1;
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return { properties, truncated };
}

/** Parse a module registry block from an app manifest source. */
export function extractManifestModuleRegistrations(
  manifestSource: string,
  key: string,
): { name: string; file: string }[] {
  const appBody = extractDefineAppObjectBody(manifestSource);
  if (!appBody) return [];
  let registryValue = scanModuleRegistryProperties(appBody).get(key);
  if (!registryValue) return [];
  registryValue = resolveTopLevelBindingAliases(manifestSource, registryValue);
  const braceStart = skipInsignificant(registryValue, 0);
  if (registryValue[braceStart] !== "{") return [];
  const braceEnd = findMatchingBrace(registryValue, braceStart, "{", "}");
  if (braceEnd === -1) return [];
  const block = registryValue.slice(braceStart + 1, braceEnd);
  const entries: { name: string; file: string }[] = [];
  for (const [name, expression] of scanModuleRegistryProperties(block)) {
    const resolvedExpression = resolveTopLevelBindingAliases(manifestSource, expression);
    const file = extractModuleRefPath(resolvedExpression);
    if (file) entries.push({ name, file });
  }
  return entries;
}

/** Resolve local identifier aliases until they reach a concrete initializer. */
function resolveTopLevelBindingAliases(source: string, expression: string): string {
  const seen = new Set<string>();
  const bindingChain: { declarationIndex: number; name: string }[] = [];
  let resolved = unwrapTransparentRegistryExpression(expression);

  while (true) {
    const identifier = extractStandaloneBindingIdentifier(resolved);
    if (!identifier || seen.has(identifier)) return resolved;
    seen.add(identifier);

    const binding = findTopLevelVariableInitializer(source, identifier);
    if (!binding) return resolved;
    bindingChain.push({ declarationIndex: binding.declarationIndex, name: identifier });

    const initializer = unwrapTransparentRegistryExpression(binding.initializer);
    if (
      startsWithObjectLiteral(initializer) &&
      bindingChain.some(
        ({ declarationIndex, name }) => !hasSingleStaticBindingUse(source, name, declarationIndex),
      )
    ) {
      // A `const` binding prevents reassignment, but its registry object can
      // still be mutated directly or through an alias. Once the object has an
      // additional runtime use, static extraction cannot prove that the
      // initializer is still the registry passed to defineApp().
      return resolved;
    }
    resolved = initializer;
  }
}

function startsWithObjectLiteral(expression: string): boolean {
  return expression[skipInsignificant(expression, 0)] === "{";
}

/**
 * Registry objects are safe to inline only when every binding in their alias
 * chain is consumed exactly once by the next alias (or by defineApp()). Any
 * extra use can mutate the object or hand it to code that does, so keep the
 * registry opaque instead of projecting a stale module map.
 */
function hasSingleStaticBindingUse(
  source: string,
  name: string,
  declarationIndex: number,
): boolean {
  const searchable = maskCommentsAndStrings(source);
  const shadowedRanges = findBindingShadowRanges(searchable, name, declarationIndex);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifier = new RegExp(`(?<![A-Za-z0-9_$])${escapedName}(?![A-Za-z0-9_$])`, "g");
  let uses = 0;

  for (const match of searchable.matchAll(identifier)) {
    if (match.index == null || match.index === declarationIndex) continue;
    if (shadowedRanges.some(({ start, end }) => match.index! >= start && match.index! < end)) {
      continue;
    }
    if (isStaticPropertyName(searchable, match.index, match[0].length)) continue;
    if (isTypeofOperand(searchable, match.index, match[0].length)) continue;

    uses += 1;
    if (uses > 1) return false;
  }

  return uses === 1;
}

/**
 * Find nested lexical scopes whose binding shadows the registry binding.
 * Those identifier occurrences do not observe or mutate the top-level object
 * whose use count guards static inlining.
 */
function findBindingShadowRanges(
  source: string,
  name: string,
  declarationIndex: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const functionBodyRanges: { start: number; end: number }[] = [];
  const controlStatementKeywords = new Set(["catch", "for", "if", "switch", "while", "with"]);
  const functions = /\bfunction\s*\*?\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*)?\(/g;

  for (const match of source.matchAll(functions)) {
    if (match.index == null) continue;
    const parametersStart = match.index + match[0].lastIndexOf("(");
    const parametersEnd = findMatchingBrace(source, parametersStart, "(", ")");
    if (parametersEnd === -1) continue;

    const bodyStart = skipInsignificant(source, parametersEnd + 1);
    if (source[bodyStart] !== "{") continue;
    const bodyEnd = findMatchingBrace(source, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    functionBodyRanges.push({ start: bodyStart, end: bodyEnd + 1 });
    if (!parameterListBindsName(source.slice(parametersStart + 1, parametersEnd), name)) {
      continue;
    }
    ranges.push({ start: parametersStart, end: bodyEnd + 1 });
  }

  const methods = /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g;
  for (const match of source.matchAll(methods)) {
    if (match.index == null) continue;
    const methodName = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(match[0])?.[0];
    if (methodName && controlStatementKeywords.has(methodName)) continue;
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(source[before])) before -= 1;
    if (
      before >= 0 &&
      source[before] !== "{" &&
      source[before] !== "," &&
      source[before] !== ";" &&
      source[before] !== "}"
    ) {
      continue;
    }

    const parametersStart = match.index + match[0].lastIndexOf("(");
    const parametersEnd = findMatchingBrace(source, parametersStart, "(", ")");
    if (parametersEnd === -1) continue;

    const bodyStart = skipInsignificant(source, parametersEnd + 1);
    if (source[bodyStart] !== "{") continue;
    const bodyEnd = findMatchingBrace(source, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    functionBodyRanges.push({ start: bodyStart, end: bodyEnd + 1 });
    if (!parameterListBindsName(source.slice(parametersStart + 1, parametersEnd), name)) {
      continue;
    }
    ranges.push({ start: parametersStart, end: bodyEnd + 1 });
  }

  for (let arrow = source.indexOf("=>"); arrow !== -1; arrow = source.indexOf("=>", arrow + 2)) {
    if (isVariableTypeAnnotationArrow(source, arrow) || isInsideTopLevelTypeAlias(source, arrow)) {
      continue;
    }
    let parameterEnd = arrow - 1;
    while (parameterEnd >= 0 && /\s/.test(source[parameterEnd])) parameterEnd -= 1;

    let parameterStart = parameterEnd;
    let parameters: string;
    if (source[parameterEnd] === ")") {
      parameterStart = findMatchingOpeningBrace(source, parameterEnd, "(", ")");
      if (parameterStart === -1) continue;
      parameters = source.slice(parameterStart + 1, parameterEnd);
    } else {
      while (parameterStart >= 0 && /[A-Za-z0-9_$]/.test(source[parameterStart])) {
        parameterStart -= 1;
      }
      parameterStart += 1;
      parameters = source.slice(parameterStart, parameterEnd + 1);
    }

    const bodyStart = skipInsignificant(source, arrow + 2);
    const bodyEnd =
      source[bodyStart] === "{"
        ? findMatchingBrace(source, bodyStart, "{", "}")
        : findArrowExpressionEnd(source, bodyStart);
    if (bodyEnd === -1) continue;
    functionBodyRanges.push({ start: bodyStart, end: bodyEnd + 1 });
    if (!parameterListBindsName(parameters, name)) continue;
    ranges.push({ start: parameterStart, end: bodyEnd + 1 });
  }

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directDeclaration = new RegExp(
    `\\b(?:class|const|function|let|var)\\s+${escapedName}\\b`,
    "g",
  );
  for (const match of source.matchAll(directDeclaration)) {
    if (match.index == null) continue;
    const nameIndex = match.index + match[0].lastIndexOf(name);
    if (nameIndex === declarationIndex || isAtModuleTopLevel(source, match.index)) continue;
    if (/^var\b/.test(match[0])) {
      const functionRange = functionBodyRanges
        .filter(({ start, end }) => match.index! >= start && match.index! < end)
        .sort((left, right) => right.start - left.start)[0];
      if (functionRange) ranges.push(functionRange);
      continue;
    }
    addEnclosingBlockShadowRange(source, match.index, ranges);
  }

  for (const match of source.matchAll(/\b(?:const|let)\s*(?=[{[])/g)) {
    if (match.index == null || isAtModuleTopLevel(source, match.index)) continue;
    const patternStart = skipInsignificant(source, match.index + match[0].length);
    const open = source[patternStart];
    const close = open === "{" ? "}" : "]";
    const patternEnd = findMatchingBrace(source, patternStart, open, close);
    if (
      patternEnd !== -1 &&
      destructuringPatternBindsName(source.slice(patternStart, patternEnd + 1), name)
    ) {
      addEnclosingBlockShadowRange(source, match.index, ranges);
    }
  }

  for (const match of source.matchAll(/\bcatch\s*\(/g)) {
    if (match.index == null) continue;
    const parametersStart = match.index + match[0].lastIndexOf("(");
    const parametersEnd = findMatchingBrace(source, parametersStart, "(", ")");
    if (
      parametersEnd === -1 ||
      !parameterListBindsName(source.slice(parametersStart + 1, parametersEnd), name)
    ) {
      continue;
    }
    const bodyStart = skipInsignificant(source, parametersEnd + 1);
    if (source[bodyStart] !== "{") continue;
    const bodyEnd = findMatchingBrace(source, bodyStart, "{", "}");
    if (bodyEnd !== -1) ranges.push({ start: parametersStart, end: bodyEnd + 1 });
  }

  return ranges;
}

/** Whether a raw `=>` belongs to a variable's TypeScript annotation. */
function isVariableTypeAnnotationArrow(source: string, arrow: number): boolean {
  let declarationStart = -1;
  for (const match of source.slice(0, arrow).matchAll(/\b(?:const|let|var)\b/g)) {
    if (match.index != null && isAtModuleTopLevel(source, match.index)) {
      declarationStart = match.index + match[0].length;
    }
  }
  if (declarationStart === -1) return false;

  let segmentStart = declarationStart;
  for (let index = declarationStart; index < arrow; index += 1) {
    if ((source[index] === "," || source[index] === ";") && isAtModuleTopLevel(source, index)) {
      segmentStart = index + 1;
    }
  }

  const segment = source.slice(segmentStart, arrow);
  if (!segment.includes(":")) return false;
  for (let index = segmentStart; index < arrow; index += 1) {
    if (source[index] === "=" && source[index + 1] !== ">" && isAtModuleTopLevel(source, index)) {
      return false;
    }
  }
  return true;
}

function addEnclosingBlockShadowRange(
  source: string,
  declarationStart: number,
  ranges: { start: number; end: number }[],
): void {
  const blockStart = findEnclosingOpeningBrace(source, declarationStart, "{", "}");
  if (blockStart === -1) return;
  const blockEnd = findMatchingBrace(source, blockStart, "{", "}");
  if (blockEnd !== -1) ranges.push({ start: blockStart, end: blockEnd + 1 });
}

function findEnclosingOpeningBrace(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index >= 0; index -= 1) {
    if (source[index] === close) depth += 1;
    if (source[index] !== open) continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return -1;
}

function findMatchingOpeningBrace(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index >= 0; index -= 1) {
    if (source[index] === close) depth += 1;
    if (source[index] === open) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findArrowExpressionEnd(source: string, start: number): number {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (atTopLevel && (char === "," || char === ";" || char === "}" || char === "]")) {
      return index - 1;
    }
    if (atTopLevel && (char === "\n" || char === "\r")) {
      const next = skipInsignificant(source, index);
      if (
        startsStaticStatement(source.slice(next), { insideTypeAssertion: false }) ||
        startsIdentifierExpressionStatement(source, index, next)
      ) {
        return index - 1;
      }
    }

    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parentheses += 1;
    else if (char === ")") {
      if (parentheses === 0) return index - 1;
      parentheses -= 1;
    }
  }

  return source.length - 1;
}

function startsIdentifierExpressionStatement(
  source: string,
  lineBreak: number,
  next: number,
): boolean {
  const nextWord = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(next))?.[0];
  if (!nextWord || new Set(["as", "in", "instanceof", "satisfies"]).has(nextWord)) return false;

  let previous = lineBreak - 1;
  while (previous >= 0 && /[ \t]/.test(source[previous])) previous -= 1;
  if (previous < 0) return false;
  if (/[)\]}'"`0-9]/.test(source[previous])) return true;
  if (!/[A-Za-z0-9_$]/.test(source[previous])) return false;

  let wordStart = previous;
  while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
  const previousWord = source.slice(wordStart + 1, previous + 1);
  return !new Set(["await", "delete", "in", "instanceof", "new", "typeof", "void", "yield"]).has(
    previousWord,
  );
}

function parameterListBindsName(parameters: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const binding = new RegExp(`^(?:\\.\\.\\.\\s*)?${escapedName}(?:\\s*[?!])?(?:\\s*[:=]|\\s*$)`);
  let cursor = 0;

  while (cursor < parameters.length) {
    const start = skipInsignificant(parameters, cursor);
    const end = skipToTopLevelComma(parameters, start);
    const parameter = parameters.slice(start, end).trim();
    if (binding.test(parameter)) return true;
    if (
      (parameter.startsWith("{") || parameter.startsWith("[")) &&
      destructuringPatternBindsName(parameter, name)
    ) {
      return true;
    }
    cursor = end < parameters.length ? end + 1 : parameters.length;
  }

  return false;
}

function destructuringPatternBindsName(pattern: string, name: string): boolean {
  const start = skipInsignificant(pattern, 0);
  const open = pattern[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return false;
  const end = findMatchingBrace(pattern, start, open, close);
  if (end === -1) return false;

  let cursor = start + 1;
  while (cursor < end) {
    const entryStart = skipInsignificant(pattern, cursor);
    const entryEnd = Math.min(skipToTopLevelComma(pattern, entryStart), end);
    let entry = pattern.slice(entryStart, entryEnd).trim();
    if (entry.startsWith("...")) entry = entry.slice(3).trimStart();

    if (open === "{") {
      const separator = findTopLevelPatternCharacter(entry, ":");
      if (separator !== -1) entry = entry.slice(separator + 1).trimStart();
    }

    const defaultValue = findTopLevelPatternCharacter(entry, "=");
    if (defaultValue !== -1) entry = entry.slice(0, defaultValue).trimEnd();
    if (entry === name || destructuringPatternBindsName(entry, name)) return true;

    cursor = entryEnd < end ? entryEnd + 1 : end;
  }

  return false;
}

function findTopLevelPatternCharacter(source: string, needle: string): number {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (atTopLevel && char === needle && source[index + 1] !== ">") return index;
    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
  }

  return -1;
}

/** A bare runtime `typeof registry` observes neither the object nor its mutable contents. */
function isTypeofOperand(source: string, start: number, length: number): boolean {
  let before = start - 1;
  while (before >= 0 && /\s/.test(source[before])) before -= 1;

  const keyword = "typeof";
  const keywordStart = before - keyword.length + 1;
  if (keywordStart < 0 || source.slice(keywordStart, before + 1) !== keyword) return false;
  if (keywordStart > 0 && /[A-Za-z0-9_$]/.test(source[keywordStart - 1])) return false;

  // Runtime member access happens before `typeof` and can invoke an accessor
  // that mutates the registry. A TypeScript type query is erased, however, so
  // member access in a top-level type alias remains harmless. TypeScript
  // non-null assertions are transparent at runtime, so look through them
  // before deciding which form this is.
  let after = skipInsignificant(source, start + length);
  while (source[after] === "!" && source[after + 1] !== "=") {
    after = skipInsignificant(source, after + 1);
  }
  const readsMember =
    source[after] === "." || source[after] === "[" || source.startsWith("?.", after);
  return !readsMember || isInsideTopLevelTypeAlias(source, keywordStart);
}

function isInsideTopLevelTypeAlias(source: string, end: number): boolean {
  const statement =
    /(?:^|[;\r\n}])\s*(?:export\s+)?(?:declare\s+)?(abstract|break|class|const|continue|debugger|do|enum|for|function|if|import|interface|let|module|namespace|return|switch|throw|try|type|var|while)\b/g;
  let latestKind: string | null = null;
  let latestKindIndex = -1;

  for (const match of source.slice(0, end).matchAll(statement)) {
    if (match.index == null) continue;
    const kindOffset = match[0].lastIndexOf(match[1]);
    const kindIndex = match.index + kindOffset;
    if (!isAtModuleTopLevel(source, kindIndex)) continue;
    const afterKind = skipInsignificant(source, kindIndex + match[1].length);
    if (match[1] === "import" && source[afterKind] === "(") continue;
    latestKind = match[1];
    latestKindIndex = kindIndex;
  }

  if (latestKind !== "type") return false;

  const typePrefix = source.slice(latestKindIndex, end);
  const lastLineBreak = Math.max(typePrefix.lastIndexOf("\n"), typePrefix.lastIndexOf("\r"));
  if (lastLineBreak === -1 || typePrefix.slice(lastLineBreak + 1).trim() !== "") return true;

  const precedingLine = typePrefix.slice(0, lastLineBreak).trimEnd();
  return (
    /(?:=|\||&|,|:|<|\(|\[|\{|\?|=>)$/.test(precedingLine) ||
    /\b(?:as|extends|in|infer|is|keyof|readonly)\s*$/.test(precedingLine)
  );
}

function isStaticPropertyName(source: string, start: number, length: number): boolean {
  let before = start - 1;
  while (before >= 0 && /\s/.test(source[before])) before -= 1;
  if (source[before] === ".") return true;

  const after = skipInsignificant(source, start + length);
  if (source[after] === ":" && (source[before] === "{" || source[before] === ",")) return true;
  if (
    source[after] === "(" &&
    (source[before] === "{" ||
      source[before] === "," ||
      source[before] === ";" ||
      source[before] === "}")
  ) {
    const parametersEnd = findMatchingBrace(source, after, "(", ")");
    return parametersEnd !== -1 && source[skipInsignificant(source, parametersEnd + 1)] === "{";
  }
  return false;
}

/**
 * Parentheses and TypeScript `as`/`satisfies` assertions do not change a
 * registry or module ref's runtime value. Remove only those transparent
 * wrappers; a following call/member/operator must remain opaque rather than
 * being mistaken for the wrapped binding.
 */
function unwrapTransparentRegistryExpression(expression: string): string {
  let resolved = expression;

  while (true) {
    const start = skipInsignificant(resolved, 0);
    if (resolved[start] !== "(") return resolved;
    const end = findMatchingBrace(resolved, start, "(", ")");
    if (end === -1 || !hasTransparentRegistryExpressionTail(resolved, end + 1)) return resolved;
    const inner = resolved.slice(start + 1, end);
    const innerStart = skipInsignificant(inner, 0);
    if (skipToTopLevelComma(inner, innerStart) < inner.length) return resolved;
    resolved = inner;
  }
}

function hasTransparentRegistryExpressionTail(expression: string, start: number): boolean {
  const tail = skipInsignificant(expression, start);
  if (tail >= expression.length || expression[tail] === ";" || expression[tail] === ",") {
    return true;
  }
  return hasStandaloneTypeAssertionTail(expression, tail);
}

function hasStandaloneTypeAssertionTail(expression: string, start: number): boolean {
  const assertion = /^(?:as|satisfies)\b/.exec(expression.slice(start));
  if (!assertion) return false;

  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let angles = 0;
  for (
    let index = skipInsignificant(expression, start + assertion[0].length);
    index < expression.length;
    index += 1
  ) {
    const char = expression[index];
    const atTypeTopLevel = braces === 0 && brackets === 0 && parentheses === 0 && angles === 0;
    if (atTypeTopLevel && /\s/.test(char)) {
      const next = skipInsignificant(expression, index);
      if (
        next > index &&
        /\r?\n/.test(expression.slice(index, next)) &&
        startsStaticStatement(expression.slice(next), { insideTypeAssertion: true })
      ) {
        return true;
      }
      if (next > index) {
        index = next - 1;
        continue;
      }
    }
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(expression, index);
      if (end === -1) return false;
      index = end;
      continue;
    }
    if (char === "/" && (expression[index + 1] === "/" || expression[index + 1] === "*")) {
      index = skipInsignificant(expression, index) - 1;
      continue;
    }

    if (atTypeTopLevel) {
      if (char === ";" || char === ",") return true;
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expression.slice(index))?.[0];
      if (word === "in" || word === "instanceof") return false;
      if (
        char === "?" ||
        char === "+" ||
        char === "-" ||
        char === "%" ||
        char === "*" ||
        char === "!" ||
        (char === "|" && expression[index + 1] === "|") ||
        (char === "&" && expression[index + 1] === "&") ||
        (char === "=" && expression[index + 1] !== ">") ||
        (char === "/" && expression[index + 1] !== "/" && expression[index + 1] !== "*") ||
        (char === ">" && expression[index - 1] !== "=" && angles === 0)
      ) {
        return false;
      }
    }

    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
    else if (char === "<") angles += 1;
    else if (char === ">" && expression[index - 1] !== "=" && angles > 0) angles -= 1;
  }

  return braces === 0 && brackets === 0 && parentheses === 0 && angles === 0;
}

/**
 * Read an identifier expression from either an extracted property value or the
 * leading initializer text returned by findTopLevelVariableInitializer().
 */
function extractStandaloneBindingIdentifier(expression: string): string | null {
  const start = skipInsignificant(expression, 0);
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expression.slice(start));
  if (!match) return null;

  const end = start + match[0].length;
  const tail = skipInsignificant(expression, end);
  const lineBreakStartsStatement =
    /\r?\n/.test(expression.slice(end, tail)) &&
    startsStaticStatement(expression.slice(tail), { insideTypeAssertion: false });
  if (
    tail >= expression.length ||
    expression[tail] === ";" ||
    expression[tail] === "," ||
    lineBreakStartsStatement ||
    hasStandaloneTypeAssertionTail(expression, tail)
  ) {
    return match[0];
  }
  return null;
}

const STATIC_STATEMENT_START_RE =
  /^(?:abstract|break|class|const|continue|debugger|declare|do|enum|export|for|function|if|interface|let|module|namespace|return|switch|throw|try|type|var|while)\b/;

function startsStaticStatement(source: string, options: { insideTypeAssertion: boolean }): boolean {
  if (STATIC_STATEMENT_START_RE.test(source)) return true;
  if (/^async\s+function\b/.test(source)) return true;
  if (!/^import\b/.test(source)) return false;

  const afterImport = skipInsignificant(source, "import".length);
  return !options.insideTypeAssertion || source[afterImport] !== "(";
}

function scanModuleRegistryProperties(block: string): Map<string, string> {
  return scanModuleRegistryPropertyEntries(block).properties;
}

function scanModuleRegistryPropertyEntries(block: string): {
  properties: Map<string, string>;
  clearsPrior: boolean;
} {
  const properties = new Map<string, string>();
  let clearsPrior = false;
  let index = 0;

  while (index < block.length) {
    const start = skipInsignificant(block, index);
    if (start >= block.length) break;
    const end = skipToTopLevelComma(block, start);
    const propertySource = block.slice(start, end);
    const spreadStart = skipInsignificant(propertySource, 0);
    if (propertySource.startsWith("...", spreadStart)) {
      const expression = unwrapTransparentRegistryExpression(propertySource.slice(spreadStart + 3));
      const objectStart = skipInsignificant(expression, 0);
      const objectEnd =
        expression[objectStart] === "{" ? findMatchingBrace(expression, objectStart, "{", "}") : -1;
      if (objectEnd !== -1 && hasTransparentRegistryExpressionTail(expression, objectEnd + 1)) {
        const spread = scanModuleRegistryPropertyEntries(
          expression.slice(objectStart + 1, objectEnd),
        );
        if (spread.clearsPrior) {
          properties.clear();
          clearsPrior = true;
        }
        for (const [name, value] of spread.properties) properties.set(name, value);
      } else {
        properties.clear();
        clearsPrior = true;
      }
      if (end >= block.length) break;
      index = end + 1;
      continue;
    }

    const parsed = scanTopLevelPropertyEntries(propertySource);
    if (parsed.truncated) {
      // An unresolved spread or computed property can replace any registration
      // that appeared before it. Forget those entries; explicit properties
      // after the opaque write can establish their own final values again.
      properties.clear();
      clearsPrior = true;
    }
    const parsedProperties = parsed.properties;
    for (const [name, expression] of parsedProperties) {
      properties.set(name, expression);
    }
    if (parsedProperties.size === 0) {
      // Object shorthand is a normal way to keep module refs readable:
      // `const pages = () => import("./pages/_middleware.ts");`
      // `middleware: { pages }`. Preserve the property name as its expression
      // so the same top-level binding resolver used for explicit values can
      // recover the module path.
      const shorthand = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(
        maskComments(propertySource),
      )?.[1];
      if (shorthand) properties.set(shorthand, shorthand);
    }
    if (end >= block.length) break;
    index = end + 1;
  }

  return { properties, clearsPrior };
}

function extractModuleRefPath(expression: string): string | null {
  const start = skipInsignificant(expression, 0);
  const quote = expression[start];
  if (quote === '"' || quote === "'") {
    const end = findStringEnd(expression, start);
    if (end === -1) return null;
    const value = evaluateLiteral(expression.slice(start, end + 1));
    return typeof value === "string" ? value : null;
  }

  const importMatch = /^\s*\(\s*\)\s*=>\s*import\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/s.exec(
    expression,
  );
  if (!importMatch) return null;
  const value = evaluateLiteral(`${importMatch[1]}${importMatch[2]}${importMatch[1]}`);
  return typeof value === "string" ? value : null;
}

function findTopLevelVariableInitializer(
  source: string,
  name: string,
): { declarationIndex: number; initializer: string } | null {
  const searchable = maskCommentsAndStrings(source);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`(\\bconst\\s+|,)\\s*${escapedName}\\b`, "g");

  for (const match of searchable.matchAll(declaration)) {
    if (match.index == null || !isAtModuleTopLevel(searchable, match.index)) continue;
    if (match[1] === "," && !followsTopLevelConstDeclaration(searchable, match.index)) continue;
    const afterName = match.index + match[0].length;
    const assignment = findVariableAssignment(searchable, afterName);
    if (assignment === -1) continue;
    return {
      declarationIndex: match.index + match[0].length - name.length,
      initializer: source.slice(skipInsignificant(source, assignment + 1)),
    };
  }

  return null;
}

function followsTopLevelConstDeclaration(source: string, end: number): boolean {
  let declarationKind: "const" | "other" | null = null;
  let declarationStart = -1;
  const keywords = /\b(?:const|import|let|var)\b/g;

  for (const match of source.slice(0, end).matchAll(keywords)) {
    if (match.index == null || !isAtModuleTopLevel(source, match.index)) continue;

    const before = source.slice(0, match.index).trimEnd().at(-1);
    if (before === ".") continue;

    if (match[0] === "import") {
      const after = source.slice(match.index + match[0].length).trimStart()[0];
      // Dynamic `import()` and `import.meta` can appear inside a variable
      // initializer; neither starts a new module declaration.
      if (after === "(" || after === ".") continue;
      declarationKind = "other";
      declarationStart = -1;
    } else {
      declarationKind = match[0] === "const" ? "const" : "other";
      declarationStart = declarationKind === "const" ? match.index + match[0].length : -1;
    }
  }

  if (declarationKind !== "const" || declarationStart === -1) return false;

  // A comma inside a generic type annotation is not a later declarator:
  // `const metadata: Record<string, notes> = ...`. A real later declarator can
  // only appear after the preceding declarator's initializer assignment.
  const assignment = findVariableAssignment(source, declarationStart);
  return assignment !== -1 && assignment < end;
}

function isAtModuleTopLevel(source: string, end: number): boolean {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;

  for (let index = 0; index < end; index += 1) {
    const char = source[index];
    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
  }

  return braces === 0 && brackets === 0 && parentheses === 0;
}

/**
 * Find the initializer assignment after a top-level variable name. Type
 * annotations can contain commas, nested object/tuple/function types, generic
 * arguments, and `=>`, so a flat regex cannot distinguish their punctuation
 * from the declaration's assignment.
 */
function findVariableAssignment(source: string, start: number): number {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let angles = 0;

  for (let index = skipInsignificant(source, start); index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") braces += 1;
    else if (char === "}") {
      if (braces === 0 && brackets === 0 && parentheses === 0 && angles === 0) return -1;
      braces = Math.max(0, braces - 1);
    } else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
    else if (char === "<") angles += 1;
    else if (char === ">" && source[index - 1] !== "=" && angles > 0) angles -= 1;

    const atDeclarationLevel = braces === 0 && brackets === 0 && parentheses === 0 && angles === 0;
    if (char === "=" && source[index + 1] !== ">" && atDeclarationLevel) return index;
    if ((char === ";" || char === ",") && atDeclarationLevel) return -1;
  }

  return -1;
}

/** Parse the `capabilities: { ... }` block of an app manifest source. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  return extractManifestModuleRegistrations(manifestSource, "capabilities");
}

/** Extract the inline object body passed to the exported app's `defineApp()`. */
export function extractDefineAppObjectBody(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const defaultExport = /export\s+default\s+defineApp\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  let parenIndex =
    defaultExport?.index != null ? defaultExport.index + defaultExport[0].length - 1 : -1;

  if (parenIndex === -1) {
    const declaration = /export\s+(?:const|let|var)\s+app\b/g;
    for (const match of searchable.matchAll(declaration)) {
      if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
      parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
      if (parenIndex !== -1) break;
    }
  }

  if (parenIndex === -1) {
    const localName = namedAppExportLocalName(searchable);
    if (localName) {
      const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`, "g");
      for (const match of searchable.matchAll(declaration)) {
        if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
        parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
        if (parenIndex !== -1) break;
      }
    }
  }

  if (parenIndex === -1) return null;
  const braceStart = skipInsignificant(source, parenIndex + 1);
  if (source[braceStart] !== "{") return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  return braceEnd === -1 ? null : source.slice(braceStart + 1, braceEnd);
}

function namedAppExportLocalName(searchable: string): string | null {
  const aliased = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+app\b/.exec(searchable);
  if (aliased) return aliased[1];
  return /export\s*\{[^}]*?\bapp\b(?:\s*,|\s*\})/.test(searchable) ? "app" : null;
}

/**
 * Find the raw text of a top-level-ish `key: { ... }` property anywhere in a
 * source file (used for the manifest's `capabilities` block).
 */
export function findTopLevelObjectProperty(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeOnly = maskCommentsAndStrings(source);
  const commentsRemoved = maskComments(source);
  const unquotedMatch = new RegExp(`\\b${escapedKey}\\s*:\\s*\\{`).exec(codeOnly);
  const quotedIndex = findQuotedObjectProperty(source, key);
  const matchIndex = [unquotedMatch?.index, quotedIndex]
    .filter((candidate): candidate is number => candidate !== undefined && candidate !== null)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return null;
  const braceStart = commentsRemoved.indexOf("{", matchIndex);
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

/** Parse an extracted data literal without evaluating application code. */
export function evaluateLiteral(expression: string): unknown {
  const parsed = parseLiteralValue(expression, 0);
  if (!parsed) return undefined;
  const end = skipInsignificant(expression, parsed.index);
  return end === expression.length ? parsed.value : undefined;
}

function skipToTopLevelComma(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return source.length;
      index = end + 1;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index);
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd;
        continue;
      }
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) return index;
    index += 1;
  }
  return source.length;
}

function skipInsignificant(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const blockEnd = source.indexOf("*/", index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Replace comments, regex literals, and optionally strings with spaces while
 * preserving source offsets. Regex-based entry-point discovery can then only
 * match live code, while the real source remains available for brace-aware
 * extraction.
 */
function maskLexicalNoise(source: string, maskStrings: boolean): string {
  const chars = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "`" && maskStrings) {
      const end = maskTemplateLiteral(source, chars, index);
      if (end === -1) return chars.slice(0, index).join("") + " ".repeat(source.length - index);
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return chars.slice(0, index).join("") + " ".repeat(source.length - index);
      if (maskStrings) {
        for (let cursor = index; cursor <= end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
      }
      index = end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const limit = end === -1 ? source.length : end;
      for (let cursor = index; cursor < limit; cursor += 1) chars[cursor] = " ";
      index = limit;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const limit = close === -1 ? source.length : close + 2;
      for (let cursor = index; cursor < limit; cursor += 1) {
        if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
      }
      index = limit;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        for (let cursor = index; cursor < end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return chars.join("");
}

/** Mask template quasis while preserving executable `${ ... }` expressions. */
function maskTemplateLiteral(source: string, chars: string[], start: number): number {
  const mask = (index: number): void => {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };
  mask(start);

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      mask(index);
      if (index + 1 < source.length) mask(++index);
      continue;
    }
    if (char === "`") {
      mask(index);
      return index;
    }
    if (char !== "$" || source[index + 1] !== "{") {
      mask(index);
      continue;
    }

    mask(index);
    mask(index + 1);
    let depth = 1;
    index += 2;
    while (index < source.length && depth > 0) {
      const inner = source[index];
      if (inner === '"' || inner === "'") {
        const end = findStringEnd(source, index);
        if (end === -1) return -1;
        for (let cursor = index; cursor <= end; cursor += 1) mask(cursor);
        index = end + 1;
        continue;
      }
      if (inner === "`") {
        const end = maskTemplateLiteral(source, chars, index);
        if (end === -1) return -1;
        index = end + 1;
        continue;
      }
      if (inner === "/" && source[index + 1] === "/") {
        const end = source.indexOf("\n", index + 2);
        const limit = end === -1 ? source.length : end;
        for (let cursor = index; cursor < limit; cursor += 1) mask(cursor);
        index = limit;
        continue;
      }
      if (inner === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        const limit = end === -1 ? source.length : end + 2;
        for (let cursor = index; cursor < limit; cursor += 1) mask(cursor);
        index = limit;
        continue;
      }
      if (inner === "/") {
        const end = regexLiteralEnd(source, index);
        if (end !== -1) {
          for (let cursor = index; cursor < end; cursor += 1) mask(cursor);
          index = end;
          continue;
        }
      }
      if (inner === "{") depth += 1;
      else if (inner === "}") {
        depth -= 1;
        if (depth === 0) {
          mask(index);
          break;
        }
      }
      index += 1;
    }
    if (depth > 0) return -1;
  }
  return -1;
}

function maskComments(source: string): string {
  return maskLexicalNoise(source, false);
}

export function maskCommentsAndStrings(source: string): string {
  return maskLexicalNoise(source, true);
}

/** Find an actual quoted property token, excluding lookalikes inside strings/comments. */
function findQuotedObjectProperty(source: string, key: string): number | null {
  let index = 0;
  while (index < source.length) {
    const next = skipInsignificant(source, index);
    if (next > index) {
      index = next;
      continue;
    }

    const char = source[index];
    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }

    const end = findStringEnd(source, index);
    if (end === -1) return null;
    if (char !== "`" && source.slice(index + 1, end) === key) {
      const colon = skipInsignificant(source, end + 1);
      const brace = source[colon] === ":" ? skipInsignificant(source, colon + 1) : -1;
      if (brace !== -1 && source[brace] === "{") return index;
    }
    index = end + 1;
  }
  return null;
}

/** Index of the closing quote of the string starting at `start`. */
function findStringEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote === "`") return findTemplateEnd(source, start);
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/**
 * Index of the closing backtick of the template literal starting at `start`.
 * Tracks `${ ... }` interpolations (including nested strings and templates
 * inside them) so an inner backtick or `}` does not end the template early.
 */
function findTemplateEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
    if (char === "$" && source[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === '"' || inner === "'" || inner === "`") {
          const end = findStringEnd(source, index);
          if (end === -1) return -1;
          index = end + 1;
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        index += 1;
      }
      if (depth > 0) return -1;
      index -= 1;
    }
  }
  return -1;
}

function findMatchingBrace(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return -1;
      index = end;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index) - 1;
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd - 1;
        continue;
      }
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "<",
  ">",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
]);
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
]);
const REGEX_STATEMENT_CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);

interface LexicalToken {
  kind: "atom" | "punctuation" | "word";
  value: string;
}

/**
 * Whether `closeIndex` closes a control-flow condition whose body may begin
 * with a regex expression statement (`if (condition) /pattern/.test(value)`).
 *
 * A closing parenthesis normally makes the following slash division. Control
 * statements are the exception, so retain just enough token context while
 * matching parentheses to distinguish them from calls such as `fn() / 2`.
 */
function closesRegexStatementControlParen(source: string, closeIndex: number): boolean {
  const controlParens: boolean[] = [];
  const tokens: LexicalToken[] = [];

  const record = (token: LexicalToken): void => {
    tokens.push(token);
    if (tokens.length > 2) tokens.shift();
  };

  for (let index = 0; index <= closeIndex; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) continue;

    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return false;
      record({ kind: "atom", value: "string" });
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        record({ kind: "atom", value: "regex" });
        index = end - 1;
        continue;
      }
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      record({ kind: "word", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
      record({ kind: "atom", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (char === "(") {
      const previous = tokens[tokens.length - 1];
      const beforePrevious = tokens[tokens.length - 2];
      const followsControlKeyword =
        previous?.kind === "word" &&
        (REGEX_STATEMENT_CONTROL_KEYWORDS.has(previous.value) ||
          (previous.value === "await" &&
            beforePrevious?.kind === "word" &&
            beforePrevious.value === "for")) &&
        beforePrevious?.value !== ".";
      controlParens.push(followsControlKeyword);
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (char === ")") {
      const closesControl = controlParens.pop() ?? false;
      if (index === closeIndex) return closesControl;
      record({ kind: "punctuation", value: char });
      continue;
    }

    record({ kind: "punctuation", value: char });
  }

  return false;
}

/**
 * If the `/` at `slashIndex` begins a regex literal (decided from the previous
 * significant token, the standard divide-vs-regex heuristic), return the index
 * just after its closing `/` and flags; otherwise -1. Keeps the brace/comma
 * scanners from miscounting a `}`/`]`/`,` inside a regex such as `/\}/`.
 */
function regexLiteralEnd(source: string, slashIndex: number): number {
  let back = slashIndex - 1;
  while (back >= 0 && /\s/.test(source[back])) back -= 1;
  let isRegex: boolean;
  if (back < 0) {
    isRegex = true;
  } else {
    const prev = source[back];
    if (REGEX_PRECEDING_PUNCTUATION.has(prev)) {
      isRegex = true;
    } else if (prev === ")" && closesRegexStatementControlParen(source, back)) {
      isRegex = true;
    } else if (/[A-Za-z0-9_$]/.test(prev)) {
      let wordStart = back;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
      isRegex = REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, back + 1));
    } else {
      // Non-control `)`, `]`, `.`, numbers → division operator, not a regex.
      isRegex = false;
    }
  }
  if (!isRegex) return -1;

  let index = slashIndex + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return -1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}

interface ParsedLiteral {
  value: unknown;
  index: number;
}

function parseLiteralValue(source: string, start: number): ParsedLiteral | null {
  const index = skipInsignificant(source, start);
  const char = source[index];
  if (char === "{") return parseObjectLiteral(source, index);
  if (char === "[") return parseArrayLiteral(source, index);
  if (char === '"' || char === "'" || char === "`") return parseStringLiteral(source, index);
  if (source.startsWith("true", index)) return parseKeyword(source, index, "true", true);
  if (source.startsWith("false", index)) return parseKeyword(source, index, "false", false);
  if (source.startsWith("null", index)) return parseKeyword(source, index, "null", null);
  return parseNumberLiteral(source, index);
}

function parseObjectLiteral(source: string, start: number): ParsedLiteral | null {
  const value: Record<string, unknown> = {};
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "}") return { value, index: index + 1 };

  while (index < source.length) {
    let key: string | null = null;
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const parsedKey = parseStringLiteral(source, index);
      if (!parsedKey || typeof parsedKey.value !== "string") return null;
      key = parsedKey.value;
      index = parsedKey.index;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (!match) return null;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(source, index);
    if (source[index] !== ":") return null;

    const parsedValue = parseLiteralValue(source, index + 1);
    if (!parsedValue) return null;
    value[key] = parsedValue.value;

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "}") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "}") return { value, index: index + 1 };
  }

  return null;
}

function parseArrayLiteral(source: string, start: number): ParsedLiteral | null {
  const value: unknown[] = [];
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "]") return { value, index: index + 1 };

  while (index < source.length) {
    const parsedValue = parseLiteralValue(source, index);
    if (!parsedValue) return null;
    value.push(parsedValue.value);

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "]") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "]") return { value, index: index + 1 };
  }

  return null;
}

function parseStringLiteral(source: string, start: number): ParsedLiteral | null {
  const quote = source[start];
  const end = findStringEnd(source, start);
  if (end === -1) return null;
  const body = source.slice(start + 1, end);
  if (quote === "`" && body.includes("${")) return null;

  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= body.length) return null;
    const escaped = body[index];
    switch (escaped) {
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "v":
        value += "\v";
        break;
      case "0":
        value += "\0";
        break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        if (body[index + 1] === "{") {
          const close = body.indexOf("}", index + 2);
          if (close === -1) return null;
          const hex = body.slice(index + 2, close);
          if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint > 0x10ffff) return null;
          value += String.fromCodePoint(codePoint);
          index = close;
          break;
        }
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escaped;
        break;
    }
  }

  return { value, index: end + 1 };
}

function parseKeyword(
  source: string,
  start: number,
  keyword: string,
  value: unknown,
): ParsedLiteral | null {
  const end = start + keyword.length;
  return /[A-Za-z0-9_$]/.test(source[end] ?? "") ? null : { value, index: end };
}

function parseNumberLiteral(source: string, start: number): ParsedLiteral | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  if (/[A-Za-z0-9_$]/.test(source[end] ?? "")) return null;
  return { value: Number(match[0]), index: end };
}

function parseNumericPropertyKey(
  source: string,
  start: number,
): { key: string; index: number } | null {
  const match =
    /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*(?:n)?|0[bB][01](?:_?[01])*(?:n)?|0[oO][0-7](?:_?[0-7])*(?:n)?|(?:0|[1-9](?:_?\d)*)n|\d(?:_?\d)*\.(?:\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)/.exec(
      source.slice(start),
    );
  if (!match) return null;

  const end = start + match[0].length;
  if (/[A-Za-z0-9_$]/.test(source[end] ?? "")) return null;

  const normalized = match[0].replaceAll("_", "");
  try {
    const value = normalized.endsWith("n") ? BigInt(normalized.slice(0, -1)) : Number(normalized);
    return { key: String(value), index: end };
  } catch {
    return null;
  }
}
