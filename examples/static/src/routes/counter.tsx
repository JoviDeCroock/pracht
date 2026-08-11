import Counter from "../islands/Counter.tsx";

export function Component() {
  return (
    <section>
      <h1>Islands</h1>
      <p>Prerendered HTML; only the counter below ships and hydrates JavaScript.</p>
      <Counter start={3} />
    </section>
  );
}
