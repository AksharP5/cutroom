import { useEffect, useRef, useState } from "react";
import { keymap, keymapAreas } from "../keymap";
import { Modal } from "./Modal";
import "./shortcuts.css";

/** Every shortcut in the keymap, by area, with a search over names and keys. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // The dialog opens in the modal's effect, which runs before this one.
  useEffect(() => search.current?.focus(), []);
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const areas = keymapAreas()
    .map(({ area, actions }) => ({
      area,
      actions: actions.filter((action) => {
        const { label, keys } = keymap[action];
        const text = `${area} ${label} ${keys.join(" ")}`.toLocaleLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter(({ actions }) => actions.length);
  return (
    <Modal title={keymap.resolveCustomizedActions.label} onClose={onClose}>
      <div className="shortcuts">
        <input
          ref={search}
          type="text"
          role="searchbox"
          aria-label="Search shortcuts"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="shortcut-scroll">
          <div className="shortcut-areas">
            {areas.map(({ area, actions }) => (
              <section key={area} aria-label={area}>
                <h3>{area}</h3>
                <dl>
                  {actions.map((action) => (
                    <div key={action}>
                      <dt>{keymap[action].label}</dt>
                      <dd>
                        {keymap[action].keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {!areas.length && <p>No shortcut matches.</p>}
        </div>
      </div>
    </Modal>
  );
}
