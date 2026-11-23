// The preview bridge's copy of export's picture rule, bundled for the browser by previewBridge.ts.
import { viewerPictures } from "../../shared/timeline/pictureSource.ts";

Reflect.set(globalThis, Symbol.for("cutroom.viewerPictures"), viewerPictures);
