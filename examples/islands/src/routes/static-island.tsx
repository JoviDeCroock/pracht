import { Card } from "../components/Card.tsx";
import Counter from "../islands/Counter.tsx";

/**
 * `hydration: "none"` with an island component on the page. Outside an
 * islands-mode render an island is an ordinary component, so this route ships
 * no JavaScript at all — but it still renders the island's markup and the card
 * the island also uses, and both need their stylesheets in the document.
 */
export function Component() {
  return (
    <section>
      <h1>Static page, island markup</h1>
      <Counter start={9} />
      <Card label="shared with the island" />
    </section>
  );
}
