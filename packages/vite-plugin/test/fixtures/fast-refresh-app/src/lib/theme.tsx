import { createContext } from "preact";
import { useContext } from "preact/hooks";

// The argument spans lines on purpose: keeping the context on a stable key
// repeats it, which moves every line below.
export const Theme = createContext({
  mode: "light",
  accent: "blue",
  radius: 4,
});

export function ThemeLabel() {
  const theme = useContext(Theme);
  return <span data-marker="THEME_MARKER">{theme.mode}</span>;
}
