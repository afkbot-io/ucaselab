import { useId, useRef, useState } from "react";
import { Bold, Italic, Code } from "lucide-react";
import Markdown from "react-markdown";
import type { Member } from "./types";

export function CommentBody({
  body,
  names,
}: {
  body: string;
  names: Record<string, string>;
}) {
  const text = body.replace(
    /@\{([a-f0-9-]{36})\}/g,
    // A display name is text, even when it contains Markdown punctuation.
    (_, id) =>
      "@" +
      (names[id] || "бывший участник").replace(
        /[\\`*_[\]{}()#+.!<>|~&-]/g,
        "\\$&",
      ),
  );
  return (
    <Markdown
      skipHtml
      urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
      components={{
        a: ({ href, children }) =>
          href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: ({ alt }) => <span>{alt}</span>,
      }}
    >
      {text}
    </Markdown>
  );
}

export function DiscussionEditor({
  value,
  onChange,
  members,
  label,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  members: Member[];
  label: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null),
    id = useId();
  const [query, setQuery] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const [active, setActive] = useState(0);
  const eligible = members
    .filter((m) =>
      m.name
        .toLocaleLowerCase()
        .includes(query?.text.toLocaleLowerCase() || ""),
    )
    .slice(0, 10);
  function lookup(text: string, caret: number) {
    const match = /(?:^|\s)@([^@{}\n]*)$/.exec(text.slice(0, caret));
    setQuery(
      match
        ? { start: caret - match[1].length - 1, end: caret, text: match[1] }
        : null,
    );
    setActive(0);
  }
  function choose(member: Member) {
    if (!query) return;
    const token = `@{${member.user_id}} `;
    onChange(value.slice(0, query.start) + token + value.slice(query.end));
    const caret = query.start + token.length;
    setQuery(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  }
  function format(mark: string) {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart,
      end = input.selectionEnd;
    onChange(
      value.slice(0, start) +
        mark +
        value.slice(start, end) +
        mark +
        value.slice(end),
    );
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + mark.length, end + mark.length);
    });
  }
  return (
    <div className="discussion-editor">
      <label htmlFor={id + "-input"}>{label}</label>
      <div className="discussion-composer">
        <div
          className="discussion-toolbar"
          role="group"
          aria-label="Форматирование"
        >
          <button
            type="button"
            className="icon-button"
            aria-label="Жирный"
            title="Жирный"
            onClick={() => format("**")}
          >
            <Bold size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Курсив"
            title="Курсив"
            onClick={() => format("*")}
          >
            <Italic size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Код"
            title="Код"
            onClick={() => format("`")}
          >
            <Code size={16} />
          </button>
        </div>
        <textarea
          className="input"
          id={id + "-input"}
          ref={ref}
          required
          maxLength={20000}
          rows={rows}
          aria-label={label}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-describedby={id + "-hint"}
          aria-expanded={!!query && eligible.length > 0}
          aria-controls={query ? id : undefined}
          aria-activedescendant={
            query && eligible[active] ? id + "-" + active : undefined
          }
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            lookup(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => lookup(value, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (!query) return;
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive(
                (v) =>
                  (v +
                    (e.key === "ArrowDown" ? 1 : -1) +
                    Math.max(1, eligible.length)) %
                  Math.max(1, eligible.length),
              );
            }
            if (e.key === "Enter" && eligible[active]) {
              e.preventDefault();
              choose(eligible[active]);
            }
          }}
          onBlur={() => setQuery(null)}
        />
        <small id={id + "-hint"}>Markdown · @ — упомянуть участника</small>
      </div>
      {query && (
        <div
          className="mention-options"
          role="listbox"
          aria-label="Участники обсуждения"
          id={id}
        >
          {eligible.length ? (
            eligible.map((m, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                id={id + "-" + i}
                key={m.user_id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(m)}
              >
                {m.name}
              </button>
            ))
          ) : (
            <span>Участники не найдены</span>
          )}
        </div>
      )}
    </div>
  );
}
