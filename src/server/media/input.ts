// Allow local media containers, excluding playlists and other indirect inputs.
export const localMediaInputOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,mp3,wav,flac,aac,ogg,aiff,avi,asf,mpeg,mpegts,flv,mxf,w64,caf",
];
