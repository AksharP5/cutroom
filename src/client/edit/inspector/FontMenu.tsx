import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { z } from "zod";
import { ApiError, api, json, reportCommittedEntry } from "../../api";
import { Modal } from "../../components/Modal";
import { SelectMenu } from "../../components/SelectMenu";
import {
  FONT_FILE_BYTES,
  FONT_FILE_EXTENSIONS,
  FontsAddedSchema,
  GoogleFamiliesSchema,
} from "../../../shared/fonts";
import type { GoogleFamily, GoogleFontWeight } from "../../../shared/fonts";

/** CSS weights by name, for every menu that offers them. */
export const WEIGHT_LABELS: Record<GoogleFontWeight, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

/** No family can be named this: family names never contain "+". */
const ADD = "+add";
const SHOWN = 50;

/** Google's catalogue, read once per editor; a failed read is tried again on the next open. */
let catalogue: Promise<GoogleFamily[]> | undefined;
const googleFamilies = () => {
  catalogue ??= api("/fonts/google", GoogleFamiliesSchema)
    .then((result) => result.families)
    .catch((error: unknown) => {
      catalogue = undefined;
      throw error;
    });
  return catalogue;
};

/**
 * The font picker for titles and text: the project's families, and Add font, which downloads a
 * Google font or imports font files into the project and then applies the new family.
 */
export function FontMenu({
  projectId,
  value,
  fonts,
  unset,
  disabled,
  onChange,
}: {
  projectId: string;
  value: string | null;
  fonts: readonly string[];
  /** The label for no font of its own, such as Auto. */
  unset: string;
  disabled: boolean;
  onChange(font: string | null): void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <SelectMenu
        label="Font"
        value={value ?? ""}
        disabled={disabled}
        options={[
          { value: "", label: unset },
          // A family just added shows before the timeline reads it back.
          ...(value === null || fonts.includes(value)
            ? fonts
            : [...fonts, value]
          ).map((font) => ({ value: font, label: font })),
          { value: ADD, label: "Add font..." },
        ]}
        onChange={(font) => {
          if (font === ADD) setAdding(true);
          else onChange(font || null);
        }}
      />
      {adding && (
        <AddFontDialog
          projectId={projectId}
          onClose={() => setAdding(false)}
          onAdded={(family) => {
            setAdding(false);
            onChange(family);
          }}
        />
      )}
    </>
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function AddFontDialog({
  projectId,
  onClose,
  onAdded,
}: {
  projectId: string;
  onClose(): void;
  onAdded(family: string): void;
}) {
  const project = `/projects/${encodeURIComponent(projectId)}`;
  const search = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [families, setFamilies] = useState<GoogleFamily[] | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<GoogleFamily | null>(null);
  const [weights, setWeights] = useState<GoogleFontWeight[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let open = true;
    googleFamilies().then(
      (list) => open && setFamilies(list),
      (failure: unknown) => open && setError(message(failure)),
    );
    return () => {
      open = false;
    };
  }, []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (families ?? [])
      .filter((family) => family.family.toLowerCase().includes(needle))
      .slice(0, SHOWN);
  }, [families, query]);

  const choose = (family: GoogleFamily) => {
    setChosen(family);
    const usual = family.weights.filter(
      (weight) => weight === 400 || weight === 700,
    );
    setWeights(usual.length ? usual : family.weights.slice(0, 1));
  };

  const run = async (work: () => Promise<z.infer<typeof FontsAddedSchema>>) => {
    setBusy(true);
    setError("");
    try {
      const added = await work();
      onAdded(added.families[0]!);
    } catch (failure) {
      setError(message(failure));
      setBusy(false);
    }
  };

  const addGoogle = () =>
    chosen &&
    run(() =>
      api(
        `${project}/fonts/google`,
        FontsAddedSchema,
        json("POST", { family: chosen.family, weights }),
      ),
    );

  const importFiles = (files: readonly File[]) => {
    const refused = files.find(
      (file) =>
        !FONT_FILE_EXTENSIONS.some((extension) =>
          file.name.toLowerCase().endsWith(extension),
        ),
    );
    if (refused) {
      setError(`${refused.name} is not a .ttf, .otf, .woff or .woff2 font.`);
      return;
    }
    const large = files.find((file) => file.size > FONT_FILE_BYTES);
    if (large) {
      setError(`${large.name} is larger than 20 MB.`);
      return;
    }
    const body = new FormData();
    for (const file of files) body.append("file", file);
    void run(async () => {
      const response = await fetch(`/api/cutroom${project}/fonts/import`, {
        method: "POST",
        body,
      });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new ApiError(
          response.status,
          z.object({ error: z.string() }).safeParse(value).data?.error ??
            `The import failed (${response.status}).`,
        );
      const added = FontsAddedSchema.parse(value);
      reportCommittedEntry(`${project}/fonts/import`, response.headers);
      return added;
    });
  };

  const acceptsFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");

  return (
    <Modal title="Add font" onClose={onClose} initialFocus={search}>
      <div
        className="font-dialog"
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragging(false);
        }}
        onDrop={(event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          if (!busy) importFiles([...event.dataTransfer.files]);
        }}
      >
        <input
          ref={search}
          type="search"
          aria-label="Search Google Fonts"
          placeholder="Search Google Fonts"
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          className="font-results"
          role="listbox"
          aria-label="Google Fonts"
          aria-busy={families === null}
        >
          {matches.map((family) => (
            <button
              key={family.family}
              type="button"
              role="option"
              aria-selected={chosen?.family === family.family}
              disabled={busy}
              onClick={() => choose(family)}
            >
              <span>{family.family}</span>
              <small>{family.category}</small>
            </button>
          ))}
        </div>
        {chosen && (
          <fieldset className="font-weights" disabled={busy}>
            <legend>{chosen.family} weights</legend>
            {chosen.weights.map((weight) => (
              <label key={weight}>
                <input
                  type="checkbox"
                  checked={weights.includes(weight)}
                  onChange={(event) =>
                    setWeights((current) =>
                      event.target.checked
                        ? [...current, weight].sort((a, b) => a - b)
                        : current.filter((item) => item !== weight),
                    )
                  }
                />
                {WEIGHT_LABELS[weight]}
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions font-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          Import files
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept={FONT_FILE_EXTENSIONS.join(",")}
          aria-label="Font files"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) importFiles(files);
          }}
        />
        <button
          type="button"
          className="primary-button"
          disabled={busy || !chosen || !weights.length}
          onClick={() => void addGoogle()}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </Modal>
  );
}
