export type NativeFormSubmitter = HTMLButtonElement | HTMLInputElement | undefined;

const validatedNativeSubmissions = new WeakSet<HTMLFormElement>();

export function consumeValidatedNativeSubmission(form: HTMLFormElement): boolean {
  return validatedNativeSubmissions.delete(form);
}

export function resolveNativeFormSubmitter(
  event: Event,
  form: HTMLFormElement,
): NativeFormSubmitter {
  const submitter =
    typeof SubmitEvent !== "undefined" && event instanceof SubmitEvent ? event.submitter : null;
  return (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
    submitter.form === form
    ? submitter
    : undefined;
}

/** Resume a validated native submission without re-entering enhanced handling. */
export function resumeValidatedNativeSubmission(
  form: HTMLFormElement,
  submitter: NativeFormSubmitter,
): void {
  validatedNativeSubmissions.add(form);
  try {
    form.requestSubmit(submitter);
  } finally {
    validatedNativeSubmissions.delete(form);
  }
}
