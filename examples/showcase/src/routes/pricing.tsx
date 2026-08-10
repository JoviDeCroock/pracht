import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface Plan {
  name: string;
  price: string;
  period: string;
  featured: boolean;
  features: string[];
}

const PLANS: Plan[] = [
  {
    name: "Starter",
    price: "$0",
    period: "",
    featured: false,
    features: ["3 projects", "1 team member", "Community support"],
  },
  {
    name: "Pro",
    price: "$29",
    period: "/mo",
    featured: true,
    features: ["Unlimited projects", "10 team members", "Priority support", "API access"],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    featured: false,
    features: ["Unlimited everything", "SSO & SAML", "Dedicated support", "SLA guarantee"],
  },
];

export async function loader(_args: LoaderArgs) {
  return {
    plans: PLANS,
    generatedAt: new Date().toISOString(),
  };
}

export function head() {
  return {
    title: "Pricing — Launchpad",
    meta: [
      { property: "og:title", content: "Launchpad Pricing" },
      { name: "description", content: "Simple pricing for teams of every size." },
    ],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="pricing">
      <span class="pricing-badge">SSG — prerendered at build</span>
      <h1>Simple pricing</h1>
      <p class="pricing-sub">
        This page uses <strong>Static Site Generation</strong>: rendered once at build time and
        served straight from the CDN. Swap <code>render</code> to <code>"isg"</code> and add{" "}
        <code>revalidate</code> to refresh it in the background instead.
      </p>
      <div class="pricing-grid">
        {data.plans.map((plan) => (
          <div key={plan.name} class={`pricing-card${plan.featured ? " featured" : ""}`}>
            <h2>{plan.name}</h2>
            <p class="price">
              {plan.price}
              {plan.period ? <span>{plan.period}</span> : null}
            </p>
            <ul>
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p class="pricing-meta">
        Last generated: <time>{data.generatedAt}</time>
      </p>
    </section>
  );
}
