import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

const HighlightedCode = lazy(() => import("./HighlightedCode"));

export type SyntaxLanguage =
  "js" | "jsx" | "ts" | "tsx" | "json" | "html" | "css";

const aliases = new Map<string, SyntaxLanguage>([
  ["js", "js"],
  ["javascript", "js"],
  ["mjs", "js"],
  ["cjs", "js"],
  ["jsx", "jsx"],
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
  ["json", "json"],
  ["html", "html"],
  ["svg", "html"],
  ["xml", "html"],
  ["css", "css"],
]);

export const CodeBlock = memo(function CodeBlock({
  text,
  language,
  complete,
}: {
  text: string;
  language: string;
  complete: boolean;
}) {
  const syntax = complete ? aliases.get(language) : undefined;
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  async function copy() {
    await navigator.clipboard.writeText(text);
    if (!button.current) return;
    setCopied(true);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1000);
  }

  return (
    <div className="chat-code">
      <pre>
        <code>
          {syntax ? (
            <Suspense fallback={text}>
              <HighlightedCode text={text} language={syntax} />
            </Suspense>
          ) : (
            text
          )}
        </code>
      </pre>
      <button
        ref={button}
        type="button"
        className="chat-copy"
        aria-label={copied ? "Copied code" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        onClick={() => void copy().catch(console.error)}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
});
