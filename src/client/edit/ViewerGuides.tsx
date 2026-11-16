import { SAFE_INSET, captionInset } from "../../shared/safeZones";
import { useWorkspace } from "../workspace";

/**
 * The safe zones and the thirds grid, over the picture. They belong to the editor, never to the
 * composition, so exports, frame captures and agents' frames never carry them. Lines sit on
 * whole screen pixels and are placed only when the picture's size changes.
 */
export function ViewerGuides({
  box,
  frame,
}: {
  /** The picture's place on the stage, in screen pixels. */
  box: { left: number; top: number; width: number; height: number };
  /** The composition's size in its own pixels. */
  frame: { width: number; height: number };
}) {
  const safeZones = useWorkspace((state) => state.safeZones);
  const grid = useWorkspace((state) => state.grid);
  if (!safeZones && !grid) return null;
  const { width, height } = box;
  const at = (extent: number, percent: number) =>
    Math.round((extent * percent) / 100);
  const inset = (percent: number) => ({
    left: at(width, percent),
    top: at(height, percent),
    width: at(width, 100 - percent) - at(width, percent),
    height: at(height, 100 - percent) - at(height, percent),
  });
  const caption = captionInset(frame);
  return (
    <div className="edit-guides" style={box} aria-hidden="true">
      {grid &&
        [1, 2].map((third) => (
          <i
            key={third}
            data-grid="x"
            style={{ left: Math.round((width * third) / 3) }}
          />
        ))}
      {grid &&
        [1, 2].map((third) => (
          <i
            key={third}
            data-grid="y"
            style={{ top: Math.round((height * third) / 3) }}
          />
        ))}
      {safeZones &&
        (["action", "title"] as const).map((zone) => (
          <b key={zone} data-zone={zone} style={inset(SAFE_INSET[zone])} />
        ))}
      {safeZones && caption.bottom !== SAFE_INSET.title && (
        <i
          data-zone="caption"
          style={{
            left: at(width, caption.side),
            width: at(width, 100 - caption.side) - at(width, caption.side),
            top: at(height, 100 - caption.bottom),
          }}
        />
      )}
    </div>
  );
}
