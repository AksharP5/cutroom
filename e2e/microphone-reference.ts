import type { Page } from "@playwright/test";

export type InputBlock = { frame: number; samples: number[] };

declare global {
  interface Window {
    microphoneReference: InputBlock[];
  }
}

/** Tap raw input quanta independently of Cutroom's PCM buffering and sample-window alignment. */
export async function referenceMicrophone(page: Page) {
  await page.addInitScript(() => {
    if (window !== top) return;
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.microphoneReference = [];
        const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = async (url, options) => {
          const source = `
            class InputReference extends AudioWorkletProcessor {
              process(inputs) {
                const samples = inputs[0]?.[0];
                if (samples) this.port.postMessage({frame: currentFrame, samples: Array.from(samples)});
                return true;
              }
            }
            registerProcessor("input-reference", InputReference);
          `;
          const module = URL.createObjectURL(
            new Blob([source], { type: "text/javascript" }),
          );
          try {
            await addModule(module);
          } finally {
            URL.revokeObjectURL(module);
          }
          await addModule(url, options);
        };
      }
      createMediaStreamSource(stream: MediaStream) {
        const source = super.createMediaStreamSource(stream);
        const tap = new AudioWorkletNode(this, "input-reference", {
          channelCount: 1,
          channelCountMode: "explicit",
        });
        tap.port.onmessage = ({ data }: MessageEvent<InputBlock>) =>
          window.microphoneReference.push(data);
        source.connect(tap).connect(this.destination);
        return source;
      }
    };
  });
}
