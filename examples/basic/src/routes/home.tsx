import { Script } from "@pracht/core";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

// Served when a client requests `Accept: text/markdown` (Markdown-for-Agents);
// llms.txt flags this route as markdown-capable.
export const markdown = `# Pracht Example

Pracht starts with an explicit app manifest.

- Hybrid route manifest
- Per-route rendering modes
- Thin deployment adapters
`;

export async function loader(_args: LoaderArgs) {
  return {
    highlights: ["Hybrid route manifest", "Per-route rendering modes", "Thin deployment adapters"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Pracht starts with an explicit app manifest.</h1>
      <ul>
        {data.highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>

      {/* Third-party script dogfood: each stub lives in public/. */}
      {/* Consent defaults must exist before any analytics runs. */}
      <Script strategy="beforeHydration" id="consent-defaults">
        {"window.__consent = { analytics: true };"}
      </Script>
      {/* Analytics loads once hydration has completed (default strategy). */}
      <Script src="/analytics.js" />
      {/* The chat widget can wait for an idle frame. */}
      <Script strategy="idle" src="/chat-widget.js" />

      {/* Pushed below the fold so the visible strategy has something to observe. */}
      <div style={{ marginTop: "120vh" }} id="support">
        <h2>Support</h2>
        <p>The support widget only loads when this section scrolls into view.</p>
        <Script strategy="visible" src="/support-widget.js" />
      </div>
    </section>
  );
}
