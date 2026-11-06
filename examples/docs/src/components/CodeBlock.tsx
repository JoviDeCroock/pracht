import { highlight, languageLabel } from "../utils/highlight";

interface CodeBlockProps {
  code: string;
  filename?: string;
  lang?: string;
}

/** The homepage's code block; same markup as the Markdown compiler emits in `content.ts`. */
export function CodeBlock({ code, filename, lang = "ts" }: CodeBlockProps) {
  const html = highlight(code.trim(), lang);
  return (
    <div class="code-block" data-lang={lang}>
      <div class="code-block-header">
        <span class="code-block-title">{filename ?? languageLabel(lang)}</span>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
