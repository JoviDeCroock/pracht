import type { RouteParams } from "@pracht/core";

export function Component({ params }: { params: RouteParams }) {
  return (
    <section id="item">
      <h1>Item {params.id}</h1>
      <p id="item-note">client-only route</p>
      <a href="/dashboard">Back to dashboard</a>
    </section>
  );
}
