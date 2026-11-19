import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LayerTextSnapshotSchema } from "../../../shared/layerText";
import type { LayerTextSnapshot } from "../../../shared/layerText";
import { api, json } from "../../api";
import { SelectMenu } from "../../components/SelectMenu";
import { showToast } from "../../workspace";
import { useCode } from "../code/code";
import {
  afterTimelineEdits,
  editCompositionSource,
  useTimeline,
} from "../timeline";
import { TextField } from "./TextField";

export function LayerTextFields({
  projectId,
  composition,
  clipId,
  revision,
  active,
  disabled,
  fallback,
}: {
  projectId: string;
  composition: string;
  clipId: string;
  revision: string;
  active: boolean;
  disabled?: boolean;
  fallback: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{
    revision: string;
    snapshot: LayerTextSnapshot;
  }>();
  const [layerId, setLayerId] = useState<string>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<{ id: string; text: string }>();
  const writing = useRef(false);
  const path = `/projects/${encodeURIComponent(projectId)}/layer-text`;
  const codeBusy = useCode(
    (state) =>
      state.projectId === projectId &&
      state.file?.path === composition &&
      (state.edited || state.saving),
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void afterTimelineEdits(projectId, () => {
      controller.signal.throwIfAborted();
      return api(
        `${path}?${new URLSearchParams({ composition, clipId })}`,
        LayerTextSnapshotSchema,
        { signal: controller.signal },
      );
    })
      .then((snapshot) => {
        if (!controller.signal.aborted) setLoaded({ revision, snapshot });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [active, clipId, composition, path, projectId, reload, revision]);

  const snapshot = loaded?.snapshot;
  const layer =
    snapshot?.layers.find(({ id }) => id === layerId) ??
    snapshot?.layers.find(({ reason }) => !reason) ??
    snapshot?.layers[0];
  if (error)
    return (
      <>
        {fallback}
        <p className="inspector-warning" role="status">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </p>
      </>
    );
  if (!snapshot || !layer) return fallback;

  const temporarilyBlocked = !!pending || loaded?.revision !== revision;
  const reason =
    layer.reason ??
    (disabled || snapshot.locked
      ? "This graphic is on a locked track."
      : codeBusy
        ? "Save or discard Source changes before editing layer text."
        : undefined);
  const save = async (text: string) => {
    if (writing.current || temporarilyBlocked || reason) return;
    writing.current = true;
    setPending({ id: layer.id, text });
    try {
      const next = await editCompositionSource(projectId, composition, () => {
        const code = useCode.getState();
        if (
          code.projectId === projectId &&
          code.file?.path === composition &&
          (code.edited || code.saving)
        )
          throw new Error(
            "Save or discard Source changes before editing layer text.",
          );
        return api(
          path,
          LayerTextSnapshotSchema,
          json("POST", {
            composition,
            clipId,
            expectedVersion: snapshot.version,
            layerId: layer.id,
            text,
          }),
        );
      });
      setLoaded({
        revision: useTimeline.getState().view?.revision ?? revision,
        snapshot: next,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      setLoaded(undefined);
      setReload((value) => value + 1);
    } finally {
      writing.current = false;
      setPending(undefined);
    }
  };
  return (
    <div className="inspector-layer-text">
      <div className="inspector-field">
        <span className="inspector-label">Layer</span>
        <div className="inspector-value">
          <SelectMenu
            label="Text layer"
            value={layer.id}
            options={snapshot.layers.map(({ id }) => ({
              value: id,
              label: id,
            }))}
            onChange={setLayerId}
          />
        </div>
      </div>
      <TextField
        key={`${snapshot.version}:${layer.id}`}
        label="Layer text"
        value={pending?.id === layer.id ? pending.text : layer.text}
        disabled={temporarilyBlocked}
        reason={reason}
        onCommit={(text) => void save(text)}
      />
    </div>
  );
}
