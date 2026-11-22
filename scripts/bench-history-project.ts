/** The history budget fixture has 480 linked picture/sound pairs and 78 titles. */
export const historyClips = 1038;
export const historyProjectHtml = `<!doctype html>
<html><head><style>.title{position:absolute;inset:0}</style></head>
<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="820" data-fps="30">
${Array.from({ length: 480 }, (_, index) => {
  const timing = `data-start="${index * 1.7}" data-duration="1.7" data-media-start="${index * 2}"`;
  return `  <video id="talk-${index}" src="talk.mp4" muted data-link="lk-${index}" ${timing} data-track-index="0"></video>
  <audio id="voice-${index}" src="talk.mp4" data-link="lk-${index}" ${timing} data-track-index="1"></audio>`;
}).join("\n")}
${Array.from(
  { length: 78 },
  (_, index) =>
    `  <div id="title-${index}" class="clip title" data-start="${index * 10 + 5}" data-duration="4" data-track-index="2">Chapter ${index + 1}</div>`,
).join("\n")}
</main></body></html>
`;
