import { useState } from "preact/hooks";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface Preferences {
  theme: string;
  emailNotifications: boolean;
  deployAlerts: boolean;
}

export async function loader(_args: LoaderArgs) {
  return {
    preferences: {
      theme: "system",
      emailNotifications: true,
      deployAlerts: true,
    } satisfies Preferences,
  };
}

export function head() {
  return { title: "Settings — Launchpad" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const [theme, setTheme] = useState(data.preferences.theme);
  const [emails, setEmails] = useState<boolean>(data.preferences.emailNotifications);
  const [deploys, setDeploys] = useState<boolean>(data.preferences.deployAlerts);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section class="settings">
      <h1>Settings</h1>
      <p class="settings-note">
        This page is <strong>SPA</strong> — the shell painted instantly, then this component loaded
        client-side. No server rendering, no SEO needed.
      </p>

      <fieldset>
        <legend>Appearance</legend>
        <label>
          Theme
          <select value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Notifications</legend>
        <label>
          <input type="checkbox" checked={emails} onChange={() => setEmails(!emails)} />
          Email notifications
        </label>
        <label>
          <input type="checkbox" checked={deploys} onChange={() => setDeploys(!deploys)} />
          Deploy alerts
        </label>
      </fieldset>

      <button type="button" class={saved ? "btn-saved" : ""} onClick={handleSave}>
        {saved ? "Saved!" : "Save preferences"}
      </button>
    </section>
  );
}
