export interface Doc {
  slug: string;
  title: string;
  body: string;
}

const DOCS: Doc[] = [
  {
    slug: "routing",
    title: "Routing",
    body: "Routes are declared in src/routes.ts and prerendered one file per path.",
  },
  {
    slug: "deploying",
    title: "Deploying",
    body: "pracht build writes dist/client; upload it anywhere that serves files.",
  },
];

export function listDocs(): Doc[] {
  return DOCS;
}

export function getDoc(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug);
}
