import "./greeting.css";
import { useServerIslandData, type ServerIslandLoaderArgs } from "@pracht/core";

export function loader({ context }: ServerIslandLoaderArgs<{ user?: string }>) {
  return { user: context.user ?? null };
}

export default function Greeting() {
  const { user } = useServerIslandData<typeof loader>();
  return <p>{user ? `Signed in as ${user}` : "Signed out"}</p>;
}
