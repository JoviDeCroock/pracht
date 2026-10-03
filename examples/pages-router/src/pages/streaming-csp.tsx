import { defer, Suspense, use } from "@pracht/core";
import type { Deferred, HeadArgs, HeadersArgs, RouteComponentProps } from "@pracht/core";

export const RENDER_MODE = "ssr";
export const STREAMING = true;

// A streamed page under a strict nonce-based CSP: every inline script the
// document carries (deferred data and Suspense swaps) must take the nonce.
type NonceContext = { cspNonce?: string };

function cspNonce(context: unknown): string {
  const ctx = context as NonceContext;
  ctx.cspNonce ??= crypto.randomUUID().replaceAll("-", "");
  return ctx.cspNonce;
}

export function head({ context }: HeadArgs) {
  return { title: "Streaming under CSP", scriptNonce: cspNonce(context) };
}

export function headers({ context }: HeadersArgs) {
  return {
    "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${cspNonce(context)}'; connect-src 'self' ws: wss:`,
  };
}

export function loader() {
  return {
    message: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("Deferred under CSP"), 150)),
    ),
  };
}

function Message({ value }: { value: Deferred<string> }) {
  return <p id="csp-streamed-message">{use(value)}</p>;
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Streaming under CSP</h1>
      <Suspense fallback={<p id="csp-streamed-fallback">Loading under CSP</p>}>
        <Message value={data.message} />
      </Suspense>
    </section>
  );
}
