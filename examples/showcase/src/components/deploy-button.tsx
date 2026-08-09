import { useState } from "preact/hooks";
import { capabilities } from "virtual:pracht/capabilities";

/**
 * The generated client, used the way you would type it by hand: dotted
 * capability names read as object paths, and both sides of the contract are
 * inferred from the name. `capabilities.projects.deployy` is a compile error
 * with a "did you mean" suggestion — not a 404 at click time.
 *
 * A successful non-`read` call revalidates the route's loader data
 * automatically; the effect class the capability already declares drives the
 * client cache, so the deploy count below updates without any wiring here.
 */
export function DeployButton({ projectId }: { projectId: string }) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Stable per mount: clicking twice proves the server deduped the retry
  // rather than shipping the same build twice.
  const [idempotencyKey] = useState(() => `ui-${projectId}-${Math.random().toString(36).slice(2)}`);

  return (
    <span class="deploy-control">
      <button
        type="button"
        class="btn-small"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const result = await capabilities.projects.deploy({ projectId, idempotencyKey });
          setPending(false);
          setNote(
            !result.ok
              ? `${result.error.code}: ${result.error.message}`
              : result.data.deduped
                ? "Same idempotency key — retry absorbed, not deployed twice."
                : `Deployed. ${result.data.deploys} total.`,
          );
        }}
      >
        {pending ? "Deploying…" : "Deploy"}
      </button>
      {note ? <span class="deploy-note">{note}</span> : null}
    </span>
  );
}
