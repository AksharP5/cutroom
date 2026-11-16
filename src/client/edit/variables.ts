import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import {
  VariableValuesSchema,
  VariablesStateSchema,
} from "../../shared/variables";
import type {
  VariableBinding,
  VariableDeclaration,
  VariableValue,
  VariableValues,
  VariablesState,
} from "../../shared/variables";
import { api, json, subscribeProjectEvents } from "../api";
import { reportEditorError, showToast } from "../workspace";

/** The open composition's declarations and the overrides its viewer previews. */
export const useVariables = create<{
  projectId: string | null;
  state: VariablesState | null;
}>(() => ({ projectId: null, state: null }));

const ChangeSchema = z.object({
  composition: z.string(),
  preview: VariableValuesSchema,
});
/** The watcher's change event; a source save can add, remove or retype a declaration. */
const FileChangeSchema = z.object({ path: z.string() });

const path = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/variables`;

/** Keeps `useVariables` on this composition while mounted. */
export function useFollowVariables(projectId: string, composition: string) {
  useEffect(() => {
    const closing = new AbortController();
    useVariables.setState({ projectId, state: null });
    const load = () =>
      api(
        `${path(projectId)}?${new URLSearchParams({ composition })}`,
        VariablesStateSchema,
        { signal: closing.signal },
      )
        .then((state) => {
          if (!closing.signal.aborted) useVariables.setState({ state });
        })
        .catch((error: unknown) => {
          if (!closing.signal.aborted) reportEditorError("timeline", error);
        });
    void load();
    const stopChanges = subscribeProjectEvents(
      projectId,
      "variables",
      (event) => {
        const change = ChangeSchema.safeParse(JSON.parse(event.data));
        const current = useVariables.getState().state;
        if (
          change.success &&
          current &&
          change.data.composition === current.composition
        )
          useVariables.setState({
            state: { ...current, preview: change.data.preview },
          });
      },
    );
    const stopFiles = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        if (
          FileChangeSchema.safeParse(JSON.parse(event.data)).data?.path ===
          composition
        )
          void load();
      },
    );
    return () => {
      closing.abort();
      stopChanges();
      stopFiles();
    };
  }, [projectId, composition]);
}

/** The preview's overrides for this composition, as the `variables` query HyperFrames reads. */
export function previewVariablesQuery(composition: string) {
  const { state } = useVariables.getState();
  return state?.composition === composition && Object.keys(state.preview).length
    ? `&variables=${encodeURIComponent(JSON.stringify(state.preview))}`
    : "";
}

const send = async (
  projectId: string,
  route: string,
  method: "PUT" | "POST",
  body: unknown,
) => {
  try {
    const state = await api(
      `${path(projectId)}${route}`,
      VariablesStateSchema,
      json(method, body),
    );
    useVariables.setState({ state });
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

/** Previews one value, or the default again when `value` is null. Never writes the source. */
export function previewVariable(
  projectId: string,
  id: string,
  value: VariableValue | null,
) {
  const { state } = useVariables.getState();
  if (!state) return;
  const { [id]: _, ...rest } = state.preview;
  const values: VariableValues =
    value === null ? rest : { ...rest, [id]: value };
  // Only values the server accepts reach the store, and with it the viewer.
  return send(projectId, "/preview", "PUT", {
    composition: state.composition,
    values,
  });
}

/** Writes the previewed value as the declared default, one undo step. */
export function makeDefault(projectId: string, id: string) {
  const { state } = useVariables.getState();
  const value = state?.preview[id];
  if (!state || value === undefined) return;
  return send(projectId, "/default", "POST", {
    composition: state.composition,
    id,
    value,
  });
}

/** Declares a variable, bound to a clip when given, one undo step. */
export function declareVariable(
  projectId: string,
  variable: VariableDeclaration,
  bind?: VariableBinding,
) {
  const { state } = useVariables.getState();
  if (!state) return;
  return send(projectId, "/declare", "POST", {
    composition: state.composition,
    variable,
    bind,
  });
}
