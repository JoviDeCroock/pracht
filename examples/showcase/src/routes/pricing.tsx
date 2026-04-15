import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

const PLANS = [
  { name: "Starter", price: "$0", features: ["3 projects", "1 team member", "Community support"] },
  {
    name: "Pro",
    price: "$29/mo",
    features: ["Unlimited projects", "10 team members", "Priority support", "API access"],
  },
  {
    name: "Enterprise",
    price: "Custom",
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
      <h1>Simple pricing</h1>
      <p class="pricing-sub">
        This page uses <strong>ISG</strong> — pre-rendered at build, revalidated every hour. Fast
        like static, always up to date.
      </p>
      <div class="pricing-grid">
        {data.plans.map((plan) => (
          <div key={plan.name} class="pricing-card">
            <h2>{plan.name}</h2>
            <p class="price">{plan.price}</p>
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
