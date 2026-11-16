/** One picture as Cutroom places it: the clip's box fills the composition, then CSS moves it. */
export interface Layer {
  frame: VideoFrame;
  /** The source's own picture size, which object-fit uses even when a proxy frame is drawn. */
  intrinsic: { width: number; height: number };
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

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 at;
uniform sampler2D picture;
uniform vec4 content;
uniform vec4 shown;
uniform float opacity;
uniform float brightness;
out vec4 colour;
void main() {
  if (at.x < shown.x || at.y < shown.y || at.x > shown.z || at.y > shown.w) discard;
  vec2 uv = (at - content.xy) / content.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec4 texel = texture(picture, uv);
  colour = vec4(texel.rgb * brightness * opacity, opacity);
}`;

/**
 * Draws pipeline layers on a WebGL2 canvas in composition pixels scaled to its backing store.
 * Shader sources are constants; only numbers reach the GPU.
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
  const shown = uniform("shown");
  const opacity = uniform("opacity");
  const brightness = uniform("brightness");
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  const local = gl.getAttribLocation(program, "local");
  gl.enableVertexAttribArray(local);
  gl.vertexAttribPointer(local, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let allocated = { width: 0, height: 0 };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  return {
    /**
     * Draws the layers bottom first over the page colour, or over nothing when it is null, in a
     * `width` x `height` composition.
     */
    draw(
      layers: readonly Layer[],
      background: string | null,
      width: number,
      height: number,
    ) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      const [r, g, b] = background
        ? [1, 3, 5].map(
            (at) => parseInt(background.slice(at, at + 2), 16) / 255,
          )
        : [0, 0, 0];
      gl.clearColor(r!, g!, b!, background ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(view, width, height);
      for (const layer of layers) {
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
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([0, 0, width, 0, 0, height, width, height]),
          gl.STREAM_DRAW,
        );
        // One allocation per picture size; each frame only replaces its pixels.
        const { displayWidth: fw, displayHeight: fh } = layer.frame;
        if (fw !== allocated.width || fh !== allocated.height) {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            fw,
            fh,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
          );
          allocated = { width: fw, height: fh };
        }
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          layer.frame,
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
    lost: () => gl.isContextLost(),
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(corners);
      gl.deleteProgram(program);
    },
  };
}
