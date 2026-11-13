import {
  AnimationFeedbackSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";

/** The commands route sends its committed result first, then one diagnostic event, and closes. */
export async function* animationEvents(response: Response) {
  if (!response.body)
    throw new Error("Timeline edit returned no event stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (event === "result")
          yield {
            event: "result" as const,
            result: TimelineViewSchema.parse(JSON.parse(data)),
          };
        if (event === "animation-left-behind")
          yield {
            event: "animation-left-behind" as const,
            feedback: AnimationFeedbackSchema.parse(JSON.parse(data)),
          };
      }
    }
  } finally {
    await reader.cancel();
  }
}
