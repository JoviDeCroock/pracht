import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  formDataToRecord,
  isApiValidationErrorBody,
  validateStandardSchema,
  type ApiValidationIssue,
} from "./api-validation.ts";
import {
  beginSubmittingNavigation,
  createNavigationLocation,
  settleNavigation,
} from "./navigation-state.ts";
import { clearPrefetchCache } from "./prefetch-cache.ts";
import { navigateToClientLocation } from "./runtime-client-fetch.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import {
  resumeValidatedNativeSubmission,
  type NativeFormSubmitter,
} from "./runtime-form-native.ts";

interface ApiFormSubmission {
  action: string | undefined;
  event: Event;
  form: HTMLFormElement;
  method: string | undefined;
  onResponse?: (response: Response) => void;
  onValidationIssues?: (issues: ApiValidationIssue[]) => void;
  schema?: StandardSchemaV1;
  submitter: NativeFormSubmitter;
}

export async function submitApiForm({
  action,
  event,
  form,
  method,
  onResponse,
  onValidationIssues,
  schema,
  submitter,
}: ApiFormSubmission): Promise<void> {
  const submitterMethod = submitter?.getAttribute("formmethod") || undefined;
  const formMethod = (submitterMethod ?? method ?? form.method ?? "post").toUpperCase();
  const isSafeMethod = SAFE_METHODS.has(formMethod);
  if (isSafeMethod && !schema) return;

  event.preventDefault();
  const submitterAction = submitter?.getAttribute("formaction");
  const actionUrl = submitterAction ?? action ?? form.action;
  const formData = new FormData(form, submitter);

  if (schema) {
    const result = await validateStandardSchema(schema, formDataToRecord(formData), "body");
    if (result.issues) {
      onValidationIssues?.(result.issues);
      return;
    }
  }

  if (isSafeMethod) {
    resumeValidatedNativeSubmission(form, submitter);
    return;
  }

  clearPrefetchCache();
  const navigationToken = beginSubmittingNavigation(createNavigationLocation(actionUrl), formData);
  try {
    const response = await fetch(actionUrl, {
      method: formMethod,
      body: formData,
      redirect: "manual",
    });

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location");
      await navigateToClientLocation(location ?? actionUrl, { reloadRouteState: true });
      return;
    }

    if ((response.status === 400 || response.status === 422) && onValidationIssues) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (isApiValidationErrorBody(body)) onValidationIssues(body.issues);
    }
    onResponse?.(response);
  } finally {
    settleNavigation(navigationToken);
  }
}
