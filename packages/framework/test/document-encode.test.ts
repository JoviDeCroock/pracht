import { transcode } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

const reference = new TextEncoder();
const longBody = "<td>3ac95df5-df42-4757-88d3-b673664e036f</td>".repeat(40);

/** A fresh module, so each test resolves the transcoder under its own runtime. */
async function loadEncoder() {
  vi.resetModules();
  return (await import("../src/document-encode.ts")).encodeDocument;
}

/** Count `transcode` calls without changing what `node:buffer` does. */
function observeTranscode(module: Record<string, unknown> = { Buffer, transcode }) {
  const calls = vi.fn();
  const observed =
    typeof module.transcode === "function"
      ? {
          ...module,
          transcode: (...args: Parameters<typeof transcode>) => {
            calls();
            return transcode(...args);
          },
        }
      : module;
  const getBuiltinModule = vi
    .spyOn(process, "getBuiltinModule")
    .mockImplementation(((id: string) => (id === "node:buffer" ? observed : undefined)) as never);
  return { calls, getBuiltinModule };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encodeDocument", () => {
  it.each([
    ["empty", ""],
    ["short ASCII", "<p>hello</p>"],
    ["long ASCII", longBody],
    ["long Latin-1", `${longBody}<p>café ÿ</p>`],
    ["short, outside Latin-1", "<p>View → 🙂</p>"],
    ["long, outside Latin-1", `${longBody}<a>View →</a>`],
    ["long, astral characters", `${longBody}<p>🙂𝒳\u{10FFFF}</p>`],
    ["long, first character past Latin-1", `\u0100${longBody}`],
    ["long, lone high surrogate", `${longBody}→\uD800<p>end</p>`],
    ["long, lone low surrogate", `${longBody}→\uDC00<p>end</p>`],
    ["long, reversed surrogate pair", `${longBody}\uDE42\uD83D`],
    ["long, trailing high surrogate", `${longBody}→\uD83D`],
    ["exactly at the length threshold", `${"a".repeat(1023)}→`],
    ["one below the length threshold", `${"a".repeat(1022)}→`],
  ])("produces the bytes TextEncoder does: %s", async (_name, html) => {
    const encodeDocument = await loadEncoder();

    const bytes = encodeDocument(html);

    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
  });

  it("transcodes a long document that holds a character outside Latin-1 on Node", async () => {
    const { calls } = observeTranscode();
    const encodeDocument = await loadEncoder();
    const html = `${longBody}<a>View →</a>`;

    const bytes = encodeDocument(html);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
  });

  it("falls back to TextEncoder when transcode rejects a lone surrogate", async () => {
    const { calls } = observeTranscode();
    const encodeDocument = await loadEncoder();
    const html = `${longBody}→\uD800`;

    const bytes = encodeDocument(html);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes.subarray(-3))).toEqual([0xef, 0xbf, 0xbd]);
    expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
  });

  it.each([
    ["ASCII", longBody],
    ["Latin-1", `${longBody}é`],
  ])("leaves a long %s document to TextEncoder", async (_name, html) => {
    const { calls } = observeTranscode();
    const encodeDocument = await loadEncoder();

    const bytes = encodeDocument(html);

    expect(calls).not.toHaveBeenCalled();
    expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
  });

  it("encodes a short document without loading node:buffer", async () => {
    const { calls, getBuiltinModule } = observeTranscode();
    const encodeDocument = await loadEncoder();

    encodeDocument("<a>View →</a>");

    expect(getBuiltinModule).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it.each(["Cloudflare-Workers", "Bun/1.3.0", "Deno/2.5.0", undefined])(
    "does not reach for node:buffer on a runtime that reports %s",
    async (userAgent) => {
      vi.stubGlobal("navigator", userAgent === undefined ? undefined : { userAgent });
      const { calls, getBuiltinModule } = observeTranscode();
      const encodeDocument = await loadEncoder();
      const html = `${longBody}<a>View →</a>`;
      const scan = vi.spyOn(RegExp.prototype, "test");

      const bytes = encodeDocument(html);

      // Nothing to gain there, so not even the scan for a wide character runs.
      expect(scan).not.toHaveBeenCalled();
      expect(getBuiltinModule).not.toHaveBeenCalled();
      expect(calls).not.toHaveBeenCalled();
      expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
    },
  );

  it("uses TextEncoder on a Node build without ICU, where transcode is absent", async () => {
    const { getBuiltinModule } = observeTranscode({ Buffer });
    const encodeDocument = await loadEncoder();
    const html = `${longBody}<a>View →</a>`;

    const bytes = encodeDocument(html);

    expect(getBuiltinModule).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes)).toEqual(Array.from(reference.encode(html)));
  });

  it("resolves node:buffer once, not per document", async () => {
    const { calls, getBuiltinModule } = observeTranscode();
    const encodeDocument = await loadEncoder();

    encodeDocument(`${longBody}→`);
    encodeDocument(`${longBody}→→`);

    expect(getBuiltinModule).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
