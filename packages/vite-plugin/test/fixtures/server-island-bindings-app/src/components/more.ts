import AdminStats from "../server-islands/AdminStats.ts";

// Reached through `export *` from the barrel: binds AdminStats only for
// importers of `AdminPanel`.
export function AdminPanel() {
  return AdminStats();
}
