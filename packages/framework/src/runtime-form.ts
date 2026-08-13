import { capabilityHttpPath } from "@pracht/capabilities";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { h } from "preact";
import type { JSX } from "preact";

import type { ApiValidationIssue } from "./api-validation.ts";
import { submitApiForm } from "./runtime-api-form.ts";
import { submitCapabilityForm } from "./runtime-capability-form.ts";
import {
  consumeValidatedNativeSubmission,
  resolveNativeFormSubmitter,
} from "./runtime-form-native.ts";
import type {
  ApiPath,
  CapabilityEnvelope,
  CapabilityOutputFor,
  HttpCapabilityName,
} from "./types.ts";

/** Envelope data type for a capability name, when typegen has registered it. */
type CapabilityFormResult<TName extends string> = CapabilityEnvelope<CapabilityOutputFor<TName>>;

export interface FormProps<TName extends HttpCapabilityName = HttpCapabilityName> extends Omit<
  JSX.HTMLAttributes<HTMLFormElement>,
  "action" | "method"
> {
  /**
   * Form action. Autocompletes API route paths registered by `pracht typegen`
   * while still accepting any URL string (dynamic segments must be
   * interpolated by the caller).
   */
  action?: ApiPath | (string & {});
  method?: string;
  /**
   * Post this form to a capability's HTTP projection instead of an `action`
   * URL — the same endpoint agents call, so the human form and the agent
   * tool literally share one contract. Fields are coerced onto the
   * capability's input schema server-side; after a successful submission the
   * active route's data revalidates automatically. Works without JavaScript:
   * the endpoint accepts the form-encoded fallback and redirects back to the
   * page. Set `action` explicitly for capabilities with a custom
   * `expose.http.path`.
   *
   * Only http-exposed capabilities are accepted: a private one has no endpoint
   * to post to, so naming it here is a compile error rather than a 404 at
   * submit time. Before `pracht typegen` has run, any name is accepted.
   */
  capability?: TName;
  /** Called with the typed envelope after a `capability` submission settles. */
  onCapabilityResult?: (envelope: CapabilityFormResult<TName>) => void;
  /**
   * Standard Schema validated against the form's data (one entry per field,
   * arrays for repeated fields) before submitting. When validation fails the
   * request is skipped and `onValidationIssues` fires with the issues.
   */
  schema?: StandardSchemaV1;
  /**
   * Called with normalized validation issues when the client-side `schema`
   * rejects a submission, or when the server responds with the standardized
   * validation failure produced by `defineApi()` (HTTP 400/422,
   * `{ error: "validation", issues }`).
   */
  onValidationIssues?: (issues: ApiValidationIssue[]) => void;
  /**
   * Called with the server's response for every non-redirect fetch
   * submission — success payloads (2xx) and failures (4xx/5xx) alike. Read
   * the body with `response.json()`; validation-issue handling parses a
   * clone, so the body is never consumed before this callback.
   */
  onResponse?: (response: Response) => void;
}

export function Form<TName extends HttpCapabilityName = HttpCapabilityName>(
  props: FormProps<TName>,
) {
  const {
    onSubmit,
    method,
    action,
    capability,
    onCapabilityResult,
    schema,
    onValidationIssues,
    onResponse,
    ...rest
  } = props;
  // Capability forms post to the capability's HTTP projection; the action
  // attribute keeps the no-JS fallback working.
  const actionAttribute = capability ? (action ?? capabilityHttpPath(capability)) : action;

  return h("form", {
    ...rest,
    method: capability ? "post" : method,
    action: actionAttribute,
    onSubmit: async (event: Event) => {
      const form = event.currentTarget;
      if (!(form instanceof HTMLFormElement)) return;
      if (consumeValidatedNativeSubmission(form)) return;

      onSubmit?.(event as never);
      if (event.defaultPrevented) return;

      const submitter = resolveNativeFormSubmitter(event, form);
      if (capability) {
        await submitCapabilityForm({
          action: actionAttribute,
          capability,
          event,
          form,
          onCapabilityResult,
          onResponse,
          onValidationIssues,
          schema,
          submitter,
        });
        return;
      }

      await submitApiForm({
        action,
        event,
        form,
        method,
        onResponse,
        onValidationIssues,
        schema,
        submitter,
      });
    },
  } as JSX.HTMLAttributes<HTMLFormElement>);
}
