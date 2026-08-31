import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div>
      <header>
        <strong>ladder</strong>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return { title: "pracht bundle ladder" };
}
