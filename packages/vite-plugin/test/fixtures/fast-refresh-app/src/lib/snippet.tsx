// Mentions the refresh calls in a string, as a page documenting them would.
const SNIPPET = "call $RefreshReg$(type, id) and $RefreshSig$() to register";

export function Snippet() {
  return <code>{SNIPPET}</code>;
}
