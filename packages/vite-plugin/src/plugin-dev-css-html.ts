export function injectDevCssLinks(html: string, manifest: Record<string, string[]>): string {
  if (!html.includes("</head>")) return html;

  const urls = [...new Set(Object.values(manifest).flat())];
  const tags = urls
    .map((url) => escapeHtmlAttribute(url))
    .filter((escapedUrl) => !html.includes(`href="${escapedUrl}"`))
    .map((escapedUrl) => `<link rel="stylesheet" href="${escapedUrl}">`);
  if (tags.length === 0) return html;

  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
