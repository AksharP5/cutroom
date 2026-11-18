import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import {
  javascriptLanguage,
  jsxLanguage,
  typescriptLanguage,
  tsxLanguage,
} from "@codemirror/lang-javascript";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import type { ReactNode } from "react";

import type { SyntaxLanguage } from "./CodeBlock";

// Use the source editor's grammars and token palette without mounting an editor.
const js = javascriptLanguage.parser;
const grammars = {
  js,
  json: js.configure({ top: "SingleExpression" }),
  jsx: jsxLanguage.parser,
  ts: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
  html: htmlLanguage.parser,
  css: cssLanguage.parser,
};

const palette = tagHighlighter([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.self],
    class: "code-keyword",
  },
  {
    tag: [
      tags.tagName,
      tags.typeName,
      tags.className,
      tags.namespace,
      tags.definition(tags.variableName),
    ],
    class: "code-name",
  },
  { tag: [tags.attributeName, tags.propertyName], class: "code-attribute" },
  {
    tag: [tags.string, tags.attributeValue, tags.regexp, tags.url],
    class: "code-string",
  },
  {
    tag: [tags.number, tags.unit, tags.bool, tags.atom, tags.color],
    class: "code-number",
  },
  { tag: [tags.comment, tags.meta], class: "code-comment" },
]);

export default function HighlightedCode({
  text,
  language,
}: {
  text: string;
  language: SyntaxLanguage;
}) {
  const parts: ReactNode[] = [];
  let end = 0;
  highlightTree(
    grammars[language].parse(text),
    palette,
    (from, to, className) => {
      if (from > end) parts.push(text.slice(end, from));
      parts.push(
        <span className={className} key={from}>
          {text.slice(from, to)}
        </span>,
      );
      end = to;
    },
  );
  parts.push(text.slice(end));
  return parts;
}
