import { useRegionData, type RegionLoaderArgs, type RegionProps } from "@pracht/core";
import Counter from "../islands/Counter.tsx";
import type { VisitorContext } from "../middleware/visitor.ts";

interface VisitorProps {
  greeting: string;
  withCounter?: boolean;
}

// Runs per request with the page route's middleware context, even when the
// page embedding this region was prerendered at build time.
export function loader({ context }: RegionLoaderArgs<VisitorContext, VisitorProps>) {
  if (context.visitor === "broken") throw new Error("Visitor region failed on purpose");
  return { visitor: context.visitor ?? null };
}

export default function Visitor({ greeting, withCounter }: VisitorProps & RegionProps) {
  const { visitor } = useRegionData<typeof loader>();
  return (
    <div class="visitor">
      <p data-testid="visitor">{visitor ? `${greeting}, ${visitor}` : "Signed out"}</p>
      {withCounter ? <Counter start={1} /> : null}
    </div>
  );
}
