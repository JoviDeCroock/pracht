import "./greeting.css";
import { useRegionData, type RegionLoaderArgs } from "@pracht/core";

export function loader({ context }: RegionLoaderArgs<{ user?: string }>) {
  return { user: context.user ?? null };
}

export default function Greeting() {
  const { user } = useRegionData<typeof loader>();
  return <p>{user ? `Signed in as ${user}` : "Signed out"}</p>;
}
