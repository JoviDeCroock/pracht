import { useParams } from "@pracht/core";

/**
 * Dynamic SPA route. One fallback document answers every `/projects/*` URL;
 * the params come from the browser's location, not from the build.
 */
export function Component() {
  const params = useParams();

  return (
    <section>
      <h1>Project</h1>
      <p data-testid="project-id">Project id: {params.id}</p>
    </section>
  );
}
