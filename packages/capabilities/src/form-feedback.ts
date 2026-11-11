import type { CapabilityErrorPayload } from "./capability.ts";

/** Validation feedback for an application's own form renderer. Values remain untrusted text. */
export interface CapabilityFormFeedback {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
  /** Only explicitly retained string fields; no files or implicit input echo. */
  values: Record<string, string>;
}

export interface CapabilityFormFeedbackOptions {
  entries?: Iterable<readonly [string, unknown]>;
  /** Public text fields that may be rendered back to the visitor. Never include secrets. */
  retain?: readonly string[];
}

export interface CapabilityFormErrorArgs {
  request: Request;
  feedback: CapabilityFormFeedback;
}

/** Optional rendering for invalid, native document form submissions. */
export interface CapabilityFormOptions {
  /** Route pathname to visit after a successful native submission; the framework adds its deploy base. */
  redirectTo: string;
  /** Public text fields to retain. Defaults to none; files are always omitted. */
  retain?: readonly string[];
  /** Return an HTML response with status 400 or 422. Runs before capability middleware. */
  onInvalid: (args: CapabilityFormErrorArgs) => Response | Promise<Response>;
}

/** Group JSON Pointer issues by their top-level form field, retaining only selected text. */
export function capabilityFormFeedback(
  error: Pick<CapabilityErrorPayload, "message" | "issues">,
  options: CapabilityFormFeedbackOptions = {},
): CapabilityFormFeedback {
  const fieldErrors: Record<string, string[]> = Object.create(null);
  const formErrors: string[] = [];
  for (const issue of error.issues ?? []) {
    if (!issue.path.startsWith("/")) {
      if (!formErrors.includes(issue.message)) formErrors.push(issue.message);
      continue;
    }
    const field = issue.path.slice(1).split("/")[0]!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(fieldErrors, field)) {
      Object.defineProperty(fieldErrors, field, { value: [], enumerable: true });
    }
    if (!fieldErrors[field]!.includes(issue.message)) fieldErrors[field]!.push(issue.message);
  }
  if (Object.keys(fieldErrors).length === 0 && formErrors.length === 0) {
    formErrors.push(error.message);
  }

  const retain = new Set(options.retain ?? []);
  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of options.entries ?? []) {
    if (!retain.has(name)) continue;
    if (typeof value !== "string") {
      delete values[name];
      continue;
    }
    Object.defineProperty(values, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return { fieldErrors, formErrors, values };
}
