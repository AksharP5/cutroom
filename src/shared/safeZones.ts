/**
 * Where content may sit on the frame, as a percent of the frame's width or height in from each
 * edge. These are the hyperframes-studio skill's safe boxes (Premiere's defaults, the same for
 * wide and vertical frames), so the viewer shows the zones agents are told to keep to:
 * everything visible inside action-safe, captions and key content inside title-safe.
 */
export const SAFE_INSET = { action: 5, title: 10 } as const;

/**
 * Where caption lines sit: the title-safe box's sides, and its bottom on a wide frame. A
 * vertical frame lifts them higher to clear the app controls drawn over the lower part.
 */
export const captionInset = (frame: { width: number; height: number }) => ({
  side: SAFE_INSET.title,
  bottom: frame.width >= frame.height ? SAFE_INSET.title : 28,
});
