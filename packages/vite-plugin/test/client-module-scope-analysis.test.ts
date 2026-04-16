import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

import { analyzeRetainedStatements, type OxcNode } from "../src/client-module-scope-analysis.ts";

function analyzeReferencedTopLevelNames(source: string): string[] {
  const program = parseAst(source, { lang: "tsx" }) as OxcNode;

  return [
    ...analyzeRetainedStatements((program.body as OxcNode[]).map((node) => ({ node })))
      .referencedTopLevelNames,
  ].sort();
}

describe("analyzeRetainedStatements", () => {
  it("does not count function parameter shadowing as a top-level reference", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page(serverOnly) {
  return <div>{serverOnly}</div>;
}
`);

    expect(names).toEqual([]);
  });

  it("does not count function-hoisted var shadowing as a top-level reference", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  if (true) {
    var serverOnly = 1;
  }

  return <div>{serverOnly}</div>;
}
`);

    expect(names).toEqual([]);
  });

  it("does not count block-scoped shadowing as a top-level reference", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  if (true) {
    const serverOnly = 1;
    return <div>{serverOnly}</div>;
  }

  return <div />;
}
`);

    expect(names).toEqual([]);
  });

  it("does not count destructured catch parameters as top-level references", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  try {
    throw { serverOnly: 1 };
  } catch ({ serverOnly }) {
    return <div>{serverOnly}</div>;
  }

  return <div />;
}
`);

    expect(names).toEqual([]);
  });

  it("handles lexical loop-header shadowing for for/for-in/for-of", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  for (let serverOnly = 0; serverOnly < 1; serverOnly++) {
    console.log(serverOnly);
  }

  for (const serverOnly of [1]) {
    console.log(serverOnly);
  }

  for (const serverOnly in { a: 1 }) {
    console.log(serverOnly);
  }

  return <div />;
}
`);

    expect(names).toEqual([]);
  });

  it("does not count switch-case lexical bindings as top-level references", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  switch (1) {
    case 1:
      const serverOnly = 1;
      return <div>{serverOnly}</div>;
    default:
      return <div />;
  }
}
`);

    expect(names).toEqual([]);
  });

  it("ignores local and aliased re-export specifiers", () => {
    const names = analyzeReferencedTopLevelNames(`
import shared from "../shared";

export { shared, shared as renamed };
`);

    expect(names).toEqual([]);
  });

  it("ignores import.meta and new.target meta properties", () => {
    const names = analyzeReferencedTopLevelNames(`
import meta from "../server-only";
import target from "../target";

export default function Page() {
  return (
    <div>
      {import.meta.env.MODE}
      {(() => new.target)()}
    </div>
  );
}
`);

    expect(names).toEqual([]);
  });

  it("ignores statement labels and break labels", () => {
    const names = analyzeReferencedTopLevelNames(`
import serverOnly from "../server-only";

export default function Page() {
  serverOnly: for (;;) {
    break serverOnly;
  }

  return <div />;
}
`);

    expect(names).toEqual([]);
  });

  it("counts computed property keys but not non-computed keys", () => {
    const names = analyzeReferencedTopLevelNames(`
import computed from "../computed";
import plain from "../plain";

export default function Page() {
  return { [computed]: 1, plain: 2 };
}
`);

    expect(names).toEqual(["computed"]);
  });

  it("counts object shorthand values but not plain property keys", () => {
    const names = analyzeReferencedTopLevelNames(`
import shorthand from "../shorthand";
import plain from "../plain";

export default function Page() {
  return { shorthand, plain: 1 };
}
`);

    expect(names).toEqual(["shorthand"]);
  });

  it("counts pattern default values and class heritage expressions", () => {
    const names = analyzeReferencedTopLevelNames(`
import fallback from "../fallback";
import Base from "../base";

class Derived extends Base {}

export default function Page({ value = fallback }) {
  return <div>{value}</div>;
}
`);

    expect(names).toEqual(["Base", "fallback"]);
  });

  it("counts uppercase JSX component identifiers but not lowercase tags", () => {
    const names = analyzeReferencedTopLevelNames(`
import Component from "../component";
import element from "../element";

export default function Page() {
  return (
    <>
      <Component />
      <element />
    </>
  );
}
`);

    expect(names).toEqual(["Component"]);
  });

  it("ignores default-exported identifiers when determining live top-level bindings", () => {
    const names = analyzeReferencedTopLevelNames(`
const Page = () => <div>ok</div>;

export default Page;
`);

    expect(names).toEqual([]);
  });

  it("counts references wrapped in TypeScript `as` assertions", () => {
    const names = analyzeReferencedTopLevelNames(`
import shared from "../shared";

export default function Page() {
  return <div>{shared as string}</div>;
}
`);

    expect(names).toEqual(["shared"]);
  });

  it("counts references wrapped in TypeScript non-null assertions", () => {
    const names = analyzeReferencedTopLevelNames(`
import shared from "../shared";

export default function Page() {
  return <div>{shared!}</div>;
}
`);

    expect(names).toEqual(["shared"]);
  });

  it("counts references wrapped in TypeScript `satisfies` expressions", () => {
    const names = analyzeReferencedTopLevelNames(`
import shared from "../shared";

export default function Page() {
  return <div>{shared satisfies unknown}</div>;
}
`);

    expect(names).toEqual(["shared"]);
  });
});
