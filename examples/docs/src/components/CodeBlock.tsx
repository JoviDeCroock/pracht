import { highlight } from "../utils/highlight";

interface CodeBlockProps {
  code: string;
  filename?: string;
}

export function CodeBlock({ code, filename }: CodeBlockProps) {
  const html = highlight(code.trim());
  return (
    <div class="code-block">
      {filename && (
        <div class="code-block-header">
          <div class="code-block-dots">
            <span />
            <span />
            <span />
          </div>
          <span class="code-block-title">{filename}</span>
        </div>
      )}
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
