import { useEffect, useRef } from "react";

/** The name in place of the row's label. The extension stays: a rename never converts a file. */
export function RenameField({
  name,
  extension = name.slice(name.lastIndexOf(".")),
  onCommit,
  onCancel,
}: {
  name: string;
  /** Shown after the field and kept; empty where the list leaves extensions out. */
  extension?: string;
  /** Resolves false when the name was refused and the field stays open to correct it. */
  onCommit(stem: string, by: "key" | "blur"): Promise<boolean>;
  onCancel(): void;
}) {
  const stem = extension ? name.slice(0, -extension.length) : name;
  const input = useRef<HTMLInputElement>(null);
  /** Enter or Escape answered; the blur that follows is not a second answer. */
  const settled = useRef(false);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const settle = (value: string, by: "key" | "blur") => {
    settled.current = true;
    const next = value.trim();
    if (!next || next === stem) return onCancel();
    void onCommit(next, by).then((done) => (settled.current = done));
  };
  return (
    <span className="media-name media-rename">
      <input
        ref={input}
        aria-label={`Rename ${name}`}
        defaultValue={stem}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(event) => {
          // Typing a name never opens, removes, or moves through the rows.
          event.stopPropagation();
          if (event.key === "Enter") settle(event.currentTarget.value, "key");
          if (event.key === "Escape") settle(stem, "key");
        }}
        onBlur={(event) => {
          if (!settled.current) settle(event.currentTarget.value, "blur");
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      {extension && <span>{extension}</span>}
    </span>
  );
}
