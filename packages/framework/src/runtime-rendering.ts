let renderToStringAsync: typeof import("preact-render-to-string").renderToStringAsync | undefined;

/** Load and retain the asynchronous Preact server renderer. */
export async function getRenderToStringAsync() {
  if (renderToStringAsync) return renderToStringAsync;
  const module = await import("preact-render-to-string");
  renderToStringAsync = module.renderToStringAsync;
  return renderToStringAsync;
}
