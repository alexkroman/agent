// Copyright 2025 the AAI authors. MIT license.
// Markdown rendering for assistant chat messages.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant prose, rendered as Markdown.
 *
 * The agent writes lists, `code`, and fenced blocks; before this they arrived
 * as literal asterisks and backticks. Styling is per-element rather than a
 * prose plugin so it stays on the studio's own type scale. GFM is on for
 * tables and strikethrough. react-markdown does not render raw HTML unless
 * rehype-raw is added — keep it that way, this text comes from a model.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
        ul: (props) => <ul className="my-1.5 list-disc pl-5" {...props} />,
        ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
        li: (props) => <li className="my-0.5" {...props} />,
        h1: (props) => <h1 className="mt-3 mb-1.5 text-[15px] font-medium" {...props} />,
        h2: (props) => <h2 className="mt-3 mb-1.5 text-[14px] font-medium" {...props} />,
        h3: (props) => <h3 className="mt-3 mb-1.5 text-[13px] font-medium" {...props} />,
        a: (props) => (
          <a
            className="text-indigo underline"
            target="_blank"
            rel="noreferrer noopener"
            {...props}
          />
        ),
        code: ({ className, children, ...rest }) => {
          // react-markdown marks fenced blocks with a language- class and
          // wraps them in <pre>; anything else is an inline span.
          const fenced = /language-/.test(className ?? "");
          return fenced ? (
            <code className="font-mono text-[11px]" {...rest}>
              {children}
            </code>
          ) : (
            <code
              className="rounded-sm border border-line bg-cream px-1 py-0.5 font-mono text-[11px]"
              {...rest}
            >
              {children}
            </code>
          );
        },
        pre: (props) => (
          <pre
            className="my-1.5 overflow-x-auto rounded-md border border-line bg-cream p-2.5"
            {...props}
          />
        ),
        blockquote: (props) => (
          <blockquote className="my-1.5 border-l-2 border-line pl-3 text-muted" {...props} />
        ),
        table: (props) => (
          <table className="my-1.5 w-full border-collapse text-[12px]" {...props} />
        ),
        th: (props) => (
          <th className="border border-line px-2 py-1 text-left font-medium" {...props} />
        ),
        td: (props) => <td className="border border-line px-2 py-1" {...props} />,
        hr: (props) => <hr className="my-2.5 border-line" {...props} />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
