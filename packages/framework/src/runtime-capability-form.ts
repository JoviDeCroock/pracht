import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
  CAPABILITY_SETTLED_EVENT,
} from "@pracht/capabilities";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  formDataToRecord,
  validateStandardSchema,
  type ApiValidationIssue,
} from "./api-validation.ts";
import {
  beginSubmittingNavigation,
  createNavigationLocation,
  settleNavigation,
} from "./navigation-state.ts";
import { clearPrefetchCache } from "./prefetch-cache.ts";
import { navigateToClientLocation, parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import {
  resumeValidatedNativeSubmission,
  type NativeFormSubmitter,
} from "./runtime-form-native.ts";
import type { CapabilityEnvelope, CapabilityOutputFor } from "./types.ts";

interface CapabilityFormSubmission<TName extends string> {
  action: string | undefined;
  capability: TName;
  event: Event;
  form: HTMLFormElement;
  onCapabilityResult?: (envelope: CapabilityEnvelope<CapabilityOutputFor<TName>>) => void;
  onResponse?: (response: Response) => void;
  onValidationIssues?: (issues: ApiValidationIssue[]) => void;
  schema?: StandardSchemaV1;
  submitter: NativeFormSubmitter;
}

export async function submitCapabilityForm<TName extends string>({
  action,
  capability,
  event,
  form,
  onCapabilityResult,
  onResponse,
  onValidationIssues,
  schema,
  submitter,
}: CapabilityFormSubmission<TName>): Promise<void> {
  const submitterAction = submitter?.getAttribute("formaction");
  const endpoint = submitterAction ?? action ?? form.action;
  const endpointUrl = parseSafeNavigationUrl(endpoint, window.location.href);
  if (!endpointUrl) {
    event.preventDefault();
    console.error(`[pracht] refused to submit capability form to unsafe URL: ${endpoint}`);
    return;
  }
  const isCrossOriginEndpoint = endpointUrl.origin !== window.location.origin;
  // A cross-origin form target cannot participate in the enhanced response
  // handshake. Let the browser perform the native submission so redirects and
  // authentication flows retain document semantics.
  if (isCrossOriginEndpoint && !schema) return;

  event.preventDefault();
  const formData = new FormData(form, submitter);

  if (schema) {
    const result = await validateStandardSchema(schema, formDataToRecord(formData), "body");
    if (result.issues) {
      onValidationIssues?.(result.issues);
      return;
    }
  }
  if (isCrossOriginEndpoint) {
    resumeValidatedNativeSubmission(form, submitter);
    return;
  }

  clearPrefetchCache();
  const navigationToken = beginSubmittingNavigation(createNavigationLocation(endpoint), formData);
  let envelope: CapabilityEnvelope;
  let response: Response | undefined;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: { [CAPABILITY_FORM_REQUEST_HEADER]: "1" },
    });
    const enhancedRedirect = response.headers.get(CAPABILITY_FORM_REDIRECT_HEADER);
    if (
      enhancedRedirect ||
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      const location =
        enhancedRedirect ?? (response.redirected ? response.url : response.headers.get("location"));
      await navigateToClientLocation(location ?? endpoint, { reloadRouteState: true });
      return;
    }
    try {
      envelope = (await response.clone().json()) as CapabilityEnvelope;
    } catch {
      envelope = {
        ok: false,
        error: {
          code: "invalid_response",
          message: `Capability endpoint returned a non-JSON response (status ${response.status}).`,
        },
      };
    }
  } catch (error: unknown) {
    envelope = {
      ok: false,
      error: {
        code: "network_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    settleNavigation(navigationToken);
  }

  if (response) onResponse?.(response);
  if (envelope.ok) form.reset();
  // The runtime provider revalidates route data on this event. The server
  // returns the matched capability's effect class so read-only form
  // submissions avoid invalidating the active route.
  window.dispatchEvent(
    new CustomEvent(CAPABILITY_SETTLED_EVENT, {
      detail: {
        name: capability,
        ok: envelope.ok,
        effect: response?.headers.get(CAPABILITY_EFFECT_HEADER) ?? null,
      },
    }),
  );
  onCapabilityResult?.(envelope as CapabilityEnvelope<CapabilityOutputFor<TName>>);
}
