import { useNavigation } from "@pracht/core";
import type { ShellProps } from "@pracht/core";

function NavigationStatus() {
  const navigation = useNavigation();
  return (
    <span
      id="nav-status"
      data-state={navigation.state}
      data-target={navigation.location?.pathname ?? ""}
    >
      {navigation.state}
    </span>
  );
}

export function Shell({ children }: ShellProps) {
  return (
    <div class="public-shell">
      <header>
        <strong>Pracht</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/pricing">Pricing</a>
        </nav>
        <NavigationStatus />
      </header>
      <main>{children}</main>
      <footer>Preact-first. Vite-native. Explicit routing.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Example",
  };
}

export function headers() {
  return {
    "x-pracht-shell": "public",
  };
}
