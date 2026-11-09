import { describe, expect, it } from "vitest";

import { capabilityFormFeedback } from "../src/index.ts";

describe("capabilityFormFeedback", () => {
  it("groups nested pointer issues by field, decodes names, and removes duplicates", () => {
    const feedback = capabilityFormFeedback({
      message: "Invalid input",
      issues: [
        { path: "/title", message: "Required" },
        { path: "/title", message: "Required" },
        { path: "/tags/0", message: "Too short" },
        { path: "/a~1b~0c", message: "Invalid" },
        { path: "", message: "Choose one option" },
      ],
    });
    expect(feedback).toEqual({
      fieldErrors: { title: ["Required"], tags: ["Too short"], "a/b~c": ["Invalid"] },
      formErrors: ["Choose one option"],
      values: {},
    });
  });

  it("retains only explicitly selected text fields, using the last submitted value", () => {
    const entries: [string, unknown][] = [
      ["title", "First"],
      ["title", '<script>alert("text")</script>'],
      ["password", "secret"],
      ["attachment", new Blob(["private"])],
    ];
    expect(capabilityFormFeedback({ message: "Invalid" }, { entries }).values).toEqual({});
    expect(
      capabilityFormFeedback(
        { message: "Invalid" },
        {
          entries,
          retain: ["title", "attachment"],
        },
      ),
    ).toEqual({
      fieldErrors: {},
      formErrors: ["Invalid"],
      values: { title: '<script>alert("text")</script>' },
    });
  });

  it("handles prototype-shaped field names as own data", () => {
    const result = capabilityFormFeedback(
      {
        message: "Invalid",
        issues: [
          { path: "/__proto__", message: "Required" },
          { path: "/constructor", message: "Invalid" },
        ],
      },
      { entries: [["__proto__", "text"]], retain: ["__proto__"] },
    );
    expect(Object.getPrototypeOf(result.fieldErrors)).toBeNull();
    expect(Object.getPrototypeOf(result.values)).toBeNull();
    expect(result.values.constructor).toBeUndefined();
    expect(Object.hasOwn(result.fieldErrors, "__proto__")).toBe(true);
    expect(result.fieldErrors["__proto__"]).toEqual(["Required"]);
    expect(result.values["__proto__"]).toBe("text");
  });
});
