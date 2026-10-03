import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

interface DisclosureProps {
  summary: string;
  open?: boolean;
  children?: ComponentChildren;
}

// The children come from the page and stay server-rendered HTML: this island
// only decides whether to show them.
export default function Disclosure({
  summary,
  open = false,
  children,
}: DisclosureProps & IslandProps) {
  const [isOpen, setOpen] = useState(open);

  return (
    <div class="disclosure">
      <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => !o)}>
        {summary}
      </button>
      {isOpen ? children : null}
    </div>
  );
}
