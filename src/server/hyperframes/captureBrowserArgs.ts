const enableFeatures = "--enable-features=";

/** Full Chromium's legacy CDP screenshot can wait two seconds for a redraw. */
export function captureBrowserArgs(args: string[]) {
  if (process.platform !== "linux") return args;
  const features = new Set<string>();
  const otherArgs: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith(enableFeatures)) {
      otherArgs.push(arg);
      continue;
    }
    for (const entry of arg.slice(enableFeatures.length).split(",")) {
      const feature = entry.trim();
      if (feature) features.add(feature);
    }
  }
  features.add("CDPScreenshotNewSurface");
  return [...otherArgs, `${enableFeatures}${[...features].join(",")}`];
}
