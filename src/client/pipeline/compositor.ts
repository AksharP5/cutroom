import { GRADE_CACHE_SIZE } from "./grades";
import type { GradeTexture } from "./grades";
import { usesPreviewColourMatrix } from "../../shared/videoColour";

/** One picture as Cutroom places it: the clip's box fills the composition, then CSS moves it. */
export interface Layer {
  frame: VideoFrame;
  /** The source's picture size as shown, which object-fit uses even when a proxy frame is drawn. */
  intrinsic: { width: number; height: number };
  /** Clockwise quarter turns from the frame's stored picture to the one shown, as a phone's matrix asks. */
  turn: 0 | 90 | 180 | 270;
  fit: "fill" | "contain" | "cover";
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise. */
  rotation: number;
  crop: { top: number; right: number; bottom: number; left: number };
  opacity: number;
  /** A dip's `brightness()` filter. */
  brightness: number;
  grade: GradeTexture | null;
}

export interface Adjustment {
  /** The number of pictures below this adjustment. */
  after: number;
  grade: GradeTexture;
}

const VERTEX = `#version 300 es
in vec2 local;
uniform mat3 place;
uniform vec2 view;
out vec2 at;
void main() {
  at = local;
  vec2 p = (place * vec3(local, 1.0)).xy / view;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

// Without `planes` it draws an RGBA picture. With them it converts the Y, U and V planes at
// the picture's own size, each chroma sample covering its 2x2 block of luma, and then filters
// the RGB to the screen, as the browser draws a <video>.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 at;
uniform sampler2D luma;
uniform sampler2D cb;
uniform sampler2D cr;
uniform bool planes;
uniform bool adjusting;
uniform vec4 stageColour;
uniform mat3 toRgb;
uniform vec3 offset;
uniform vec4 content;
uniform mat3 orient;
uniform vec4 shown;
uniform float opacity;
uniform float brightness;
uniform highp sampler3D grade;
uniform vec2 gradeGrid;
out vec4 colour;
vec3 rgbAt(ivec2 texel) {
  texel = clamp(texel, ivec2(0), textureSize(luma, 0) - 1);
  vec3 ycbcr = vec3(
    texelFetch(luma, texel, 0).r,
    texelFetch(cb, texel / 2, 0).r,
    texelFetch(cr, texel / 2, 0).r
  );
  return clamp(toRgb * (ycbcr - offset), 0.0, 1.0);
}
vec3 applyGrade(vec3 rgb) {
  return gradeGrid.x > 0.0 ? texture(grade, rgb * gradeGrid.x + gradeGrid.y).rgb : rgb;
}
void main() {
  if (stageColour.a > 0.0) {
    colour = stageColour;
    return;
  }
  if (adjusting) {
    vec4 below = texelFetch(luma, ivec2(gl_FragCoord.xy), 0);
    colour = below.a > 0.0 ? vec4(applyGrade(below.rgb / below.a) * below.a, below.a) : below;
    return;
  }
  if (at.x < shown.x || at.y < shown.y || at.x > shown.z || at.y > shown.w) discard;
  vec2 uv = (at - content.xy) / content.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  uv = (orient * vec3(uv, 1.0)).xy;
  vec3 rgb;
  if (!planes) rgb = texture(luma, uv).rgb;
  else {
    vec2 p = uv * vec2(textureSize(luma, 0)) - 0.5;
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    rgb = mix(
      mix(rgbAt(i), rgbAt(i + ivec2(1, 0)), f.x),
      mix(rgbAt(i + ivec2(0, 1)), rgbAt(i + ivec2(1, 1)), f.x),
      f.y
    );
  }
  colour = vec4(applyGrade(rgb) * brightness * opacity, opacity);
}`;

/**
 * Where a point of the shown picture lies in the stored one, column-major: shown (u, v) is stored
 * (v, 1 - u) after a clockwise quarter turn.
 */
const ORIENT: Record<Layer["turn"], number[]> = {
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  90: [0, -1, 0, 1, 0, 0, 0, 1, 1],
  180: [-1, 0, 0, 0, -1, 0, 1, 1, 1],
  270: [0, 1, 0, -1, 0, 0, 1, 0, 1],
};

/** Luma weights of the YCbCr matrices Cutroom's footage uses. */
const WEIGHTS: Partial<Record<VideoMatrixCoefficients, [number, number]>> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
};

/**
 * The column-major matrix and offset that turn 8-bit YCbCr samples, read as 0 to 1, into RGB.
 * Null for a matrix or gamut this does not draw as Chrome does, which then draws through the
 * browser's own conversion.
 */
function conversion(space: VideoColorSpace) {
  if (!usesPreviewColourMatrix(space.primaries ?? "", space.transfer ?? ""))
    return null;
  const weights = WEIGHTS[space.matrix ?? "bt709"];
  if (!weights) return null;
  const [kr, kb] = weights;
  const kg = 1 - kr - kb;
  const [lumaScale, chromaScale] = space.fullRange
    ? [1, 1]
    : [255 / 219, 255 / 224];
  const red = 2 * (1 - kr) * chromaScale;
  const blue = 2 * (1 - kb) * chromaScale;
  return {
    // Columns: what Y, Cb and Cr each add to red, green and blue.
    matrix: [
      ...[lumaScale, lumaScale, lumaScale],
      ...[0, (-blue * kb) / kg, blue],
      ...[red, (-red * kr) / kg, 0],
    ],
    offset: [space.fullRange ? 0 : 16 / 255, 128 / 255, 128 / 255],
  };
}

/** Plane sizes of 8-bit 4:2:0 pictures, as a fraction of the picture. */
const I420 = [1, 0.5, 0.5];

/**
 * Draws pipeline layers on a WebGL2 canvas in composition pixels scaled to its backing store.
 * Shader sources are constants; only numbers reach the GPU.
 *
 * Decoded pictures go up as their own Y, U and V planes. Handing a software-decoded VideoFrame to
 * `texImage2D` converts it through a canvas whose image cache keeps every converted picture, which
 * after one drag across a long timeline held about 500 MB. Other layouts still take that path.
 */
export function createCompositor(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 is unavailable.");
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "A shader failed.");
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "The program failed.");
  gl.useProgram(program);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const place = uniform("place");
  const view = uniform("view");
  const content = uniform("content");
  const orient = uniform("orient");
  const shown = uniform("shown");
  const opacity = uniform("opacity");
  const brightness = uniform("brightness");
  const planes = uniform("planes");
  const adjusting = uniform("adjusting");
  const stageColour = uniform("stageColour");
  const toRgb = uniform("toRgb");
  const offset = uniform("offset");
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  const local = gl.getAttribLocation(program, "local");
  gl.enableVertexAttribArray(local);
  gl.vertexAttribPointer(local, 2, gl.FLOAT, false, 0, 0);
  // One texture per plane; an RGBA picture uses the first.
  const textures = ["luma", "cb", "cr"].map((name, unit) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniform(name), unit);
    return { texture, unit, shape: "" };
  });
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const gradeUnit = gl.TEXTURE0 + textures.length;
  gl.uniform1i(uniform("grade"), textures.length);
  const gradeGrid = uniform("gradeGrid");
  const grades = new Map<number, WebGLTexture>();
  const ungraded = gl.createTexture();
  gl.activeTexture(gradeUnit);
  gl.bindTexture(gl.TEXTURE_3D, ungraded);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, 1, 1, 1);
  let boundGrade: number | null = null;
  const bindGrade = (lut: GradeTexture | null) => {
    const key = lut?.key ?? null;
    if (key === boundGrade) return;
    boundGrade = key;
    gl.activeTexture(gradeUnit);
    if (!lut) {
      gl.bindTexture(gl.TEXTURE_3D, ungraded);
      gl.uniform2f(gradeGrid, 0, 0);
      return;
    }
    let texture = grades.get(lut.key);
    if (texture) {
      grades.delete(lut.key);
      gl.bindTexture(gl.TEXTURE_3D, texture);
    } else {
      if (grades.size >= GRADE_CACHE_SIZE) {
        const oldest = grades.keys().next().value!;
        gl.deleteTexture(grades.get(oldest)!);
        grades.delete(oldest);
      }
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        lut.size,
        lut.size,
        lut.size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        lut.data,
      );
    }
    grades.set(lut.key, texture);
    // The cube's first and last values live at the centres of the edge texels.
    gl.uniform2f(gradeGrid, (lut.size - 1) / lut.size, 0.5 / lut.size);
  };
  let backdrop: WebGLTexture | null = null;
  let backdropWidth = 0;
  let backdropHeight = 0;
  const applyAdjustment = ({ grade }: Adjustment) => {
    // Sample the composited, premultiplied picture. It stays on the GPU, with the
    // same alpha, and replaces the pixels below before drawing any higher tracks.
    gl.activeTexture(gl.TEXTURE0);
    if (!backdrop) {
      backdrop = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, backdrop);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else gl.bindTexture(gl.TEXTURE_2D, backdrop);
    const { width, height } = canvas;
    if (width !== backdropWidth || height !== backdropHeight) {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0);
      backdropWidth = width;
      backdropHeight = height;
    } else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    gl.uniformMatrix3fv(place, false, ORIENT[0]);
    gl.uniform1i(adjusting, 1);
    bindGrade(grade);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.uniform1i(adjusting, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]!.texture);
  };

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  /** Each layer's plane bytes, reused from draw to draw. */
  const buffers: Uint8Array[] = [];
  let disposed = false;
  const isAvailable = () => !disposed && !gl.isContextLost();
  // The canvas is hidden before its first draw. Track its parent so playback can size the
  // backing store without forcing layout on every frame.
  const picture = canvas.parentElement ?? canvas;
  let size: DOMRectReadOnly = picture.getBoundingClientRect();
  const resize = new ResizeObserver(([entry]) => {
    if (entry) size = entry.contentRect;
  });
  resize.observe(picture);

  /** Allocates a texture only when its size or format changes; each draw replaces its pixels. */
  const upload = (
    plane: (typeof textures)[number],
    width: number,
    height: number,
    format: number,
    internal: number,
    pixels: Uint8Array | VideoFrame,
    stride = 0,
  ) => {
    gl.activeTexture(gl.TEXTURE0 + plane.unit);
    const shape = `${width}x${height}:${internal}`;
    if (plane.shape !== shape) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internal,
        width,
        height,
        0,
        format,
        gl.UNSIGNED_BYTE,
        null,
      );
      plane.shape = shape;
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
    if (pixels instanceof VideoFrame)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        format,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        format,
        gl.UNSIGNED_BYTE,
        pixels,
      );
  };

  /** Copies a layer's planes out of its frame, or null when the browser must convert it. */
  const copy = async (frame: VideoFrame, slot: number) => {
    const convert = conversion(frame.colorSpace);
    if (frame.format !== "I420" || !convert) return null;
    const length = frame.allocationSize();
    if ((buffers[slot]?.byteLength ?? 0) < length)
      buffers[slot] = new Uint8Array(length);
    const bytes = buffers[slot]!;
    const layout = await frame.copyTo(bytes);
    const { width, height } = frame.visibleRect!;
    return {
      convert,
      planes: layout.map(({ offset, stride }, index) => ({
        width: Math.ceil(width * I420[index]!),
        height: Math.ceil(height * I420[index]!),
        stride,
        bytes: bytes.subarray(offset),
      })),
    };
  };

  return {
    /**
     * Draws the layers bottom first over the page colour, or over nothing when it is null, in a
     * `width` x `height` composition. The frames stay open until it resolves.
     */
    async draw(
      layers: readonly Layer[],
      background: string | null,
      width: number,
      height: number,
      adjustments: readonly Adjustment[] = [],
    ) {
      const copies = await Promise.all(
        layers.map((layer, slot) => copy(layer.frame, slot)),
      );
      if (!isAvailable()) return;
      // Sized after the copies, since resizing clears the picture still on screen.
      const backing = [size.width, size.height].map((side) =>
        Math.max(1, Math.round(side * devicePixelRatio)),
      );
      if (canvas.width !== backing[0] || canvas.height !== backing[1])
        [canvas.width, canvas.height] = backing as [number, number];
      gl.viewport(0, 0, canvas.width, canvas.height);
      const [r, g, b] = background
        ? [1, 3, 5].map(
            (at) => parseInt(background.slice(at, at + 2), 16) / 255,
          )
        : [0, 0, 0];
      if (adjustments.length) gl.clearColor(0, 0, 0, 0);
      else gl.clearColor(r!, g!, b!, background ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(view, width, height);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, width, 0, 0, height, width, height]),
        gl.STREAM_DRAW,
      );
      let adjustment = 0;
      for (const [index, layer] of layers.entries()) {
        while (adjustments[adjustment]?.after === index)
          applyAdjustment(adjustments[adjustment++]!);
        if (layer.opacity <= 0) continue;
        const { width: iw, height: ih } = layer.intrinsic;
        // object-fit, centred as object-position's default.
        const scale =
          layer.fit === "contain"
            ? Math.min(width / iw, height / ih)
            : layer.fit === "cover"
              ? Math.max(width / iw, height / ih)
              : null;
        const cw = scale === null ? width : iw * scale;
        const ch = scale === null ? height : ih * scale;
        gl.uniform4f(content, (width - cw) / 2, (height - ch) / 2, cw, ch);
        gl.uniformMatrix3fv(orient, false, ORIENT[layer.turn]);
        // clip-path: inset() on the box, which also bounds a covering picture.
        const { top, right, bottom, left } = layer.crop;
        gl.uniform4f(shown, left, top, width - right, height - bottom);
        // translate, rotate, then scale, about the box's centre.
        const angle = (layer.rotation * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const ox = width / 2;
        const oy = height / 2;
        const a = cos * layer.scaleX;
        const b2 = sin * layer.scaleX;
        const c = -sin * layer.scaleY;
        const d = cos * layer.scaleY;
        const tx = ox + layer.x - (a * ox + c * oy);
        const ty = oy + layer.y - (b2 * ox + d * oy);
        gl.uniformMatrix3fv(place, false, [a, b2, 0, c, d, 0, tx, ty, 1]);
        gl.uniform1f(opacity, layer.opacity);
        gl.uniform1f(brightness, layer.brightness);
        const copied = copies[index];
        if (copied) {
          gl.uniform1i(planes, 1);
          gl.uniformMatrix3fv(toRgb, false, copied.convert.matrix);
          gl.uniform3fv(offset, copied.convert.offset);
          for (const [at, plane] of copied.planes.entries())
            upload(
              textures[at]!,
              plane.width,
              plane.height,
              gl.RED,
              gl.R8,
              plane.bytes,
              plane.stride,
            );
        } else {
          gl.uniform1i(planes, 0);
          const { displayWidth: fw, displayHeight: fh } = layer.frame;
          upload(textures[0]!, fw, fh, gl.RGBA, gl.RGBA, layer.frame);
        }
        bindGrade(layer.grade);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      while (adjustment < adjustments.length)
        applyAdjustment(adjustments[adjustment++]!);
      // The page colour lies behind the tracks. It does not enter a graded composite.
      if (adjustments.length && background) {
        gl.uniformMatrix3fv(place, false, ORIENT[0]);
        gl.uniform4f(stageColour, r!, g!, b!, 1);
        gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform4f(stageColour, 0, 0, 0, 0);
      }
    },
    isAvailable,
    dispose() {
      if (disposed) return;
      disposed = true;
      resize.disconnect();
      for (const { texture } of textures) gl.deleteTexture(texture);
      for (const texture of grades.values()) gl.deleteTexture(texture);
      grades.clear();
      gl.deleteTexture(ungraded);
      gl.deleteTexture(backdrop);
      gl.deleteBuffer(corners);
      gl.deleteProgram(program);
      buffers.length = 0;
    },
  };
}
