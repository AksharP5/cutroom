import {
  parseAutomation,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import type { HfAutomation } from "@hyperframes/core/audio-automation";

// The timeline treats these values as immutable. Shifted lanes share the original points.
const parsed = new Map<string, HfAutomation>();

function remember(raw: string, automation: HfAutomation) {
  if (parsed.size >= 128) parsed.delete(parsed.keys().next().value!);
  parsed.set(raw, automation);
  return automation;
}

export function readAutomation(raw: string) {
  return parsed.get(raw) ?? remember(raw, parseAutomation(raw));
}

export function writeAutomation(automation: HfAutomation) {
  const raw = serializeAutomation(automation);
  remember(raw, automation);
  return raw;
}
