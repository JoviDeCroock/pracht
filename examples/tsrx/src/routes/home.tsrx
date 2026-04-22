import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    features: [
      "Compiled by @tsrx/vite-plugin-preact",
      "Mixes freely with .tsx routes",
      "Per-component scoped <style> blocks",
    ],
    greeting: "Hello from a .tsrx route",
  };
}

export component Component(props: RouteComponentProps<typeof loader>) {
  <section class="tsrx-home">
    <h1>{props.data.greeting}</h1>
    <p>{"This page is rendered from a .tsrx file."}</p>
    <ul>
      for (const feature of props.data.features) {
        <li>{feature}</li>
      }
    </ul>
  </section>

  <style>
    .tsrx-home {
      padding: 2rem;
      border: 1px dashed rebeccapurple;
      border-radius: 0.5rem;
    }
    h1 {
      color: rebeccapurple;
      margin-top: 0;
    }
  </style>
}
