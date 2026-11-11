import { parse } from "acorn";
import type { AnyNode } from "acorn";

/** A deliberately closed script grammar. Every unrecognised statement refuses Position. */
export function positionAnimations(script: string) {
  const animations: { selector: string; properties: Set<string> }[] = [];
  const timelines = new Map<string, Set<string>>();
  const unknown = () => {
    throw new Error(
      "Position is unavailable with custom or unrecognised animation scripts.",
    );
  };
  const member = (node: AnyNode): string | null => {
    if (node.type === "Identifier") return node.name;
    if (node.type !== "MemberExpression") return null;
    if (node.computed || node.property.type !== "Identifier") return null;
    const object = member(node.object);
    return object ? `${object}.${node.property.name}` : null;
  };
  const properties = (node: AnyNode, keys = new Set<string>()): Set<string> => {
    if (node.type === "Literal") return keys;
    if (node.type === "UnaryExpression") {
      if (!["+", "-"].includes(node.operator)) return unknown();
      return properties(node.argument, keys);
    }
    if (node.type === "ArrayExpression") {
      for (const item of node.elements) {
        if (!item) return unknown();
        properties(item, keys);
      }
      return keys;
    }
    if (node.type !== "ObjectExpression") return unknown();
    for (const property of node.properties) {
      if (
        property.type !== "Property" ||
        property.computed ||
        property.method ||
        property.kind !== "init"
      )
        return unknown();
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal"
            ? property.key.value
            : null;
      if (typeof key !== "string" || /^on[A-Z]/.test(key)) return unknown();
      // These containers can set CSS/attributes at any point in a tween. Require their contents,
      // including keyframes and timeline defaults, to be static too.
      if (
        ["css", "attr", "startAt", "defaults", "keyframes"].includes(key) &&
        property.value.type !== "ObjectExpression" &&
        property.value.type !== "ArrayExpression"
      )
        return unknown();
      keys.add(key);
      properties(property.value, keys);
    }
    return keys;
  };
  const timeline = (node: AnyNode, requireTimeline = false): Set<string> => {
    if (node.type === "Identifier")
      return timelines.get(node.name) ?? unknown();
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.property.type !== "Identifier"
    )
      return unknown();
    const method = node.callee.property.name;
    if (member(node.callee.object) === "gsap" && method === "timeline") {
      if (node.arguments.length > 1) return unknown();
      const options = node.arguments[0];
      if (options && options.type !== "ObjectExpression") return unknown();
      return options ? properties(options) : new Set();
    }
    if (!["to", "from", "fromTo", "set"].includes(method)) return unknown();
    const direct = member(node.callee.object) === "gsap";
    if (direct && requireTimeline) return unknown();
    const inherited = direct
      ? new Set<string>()
      : timeline(node.callee.object, true);
    const count = method === "fromTo" ? 3 : 2;
    if (node.arguments.length < count || node.arguments.length > count + 1)
      return unknown();
    const target = node.arguments[0];
    if (target.type !== "Literal" || typeof target.value !== "string")
      return unknown();
    const keys = new Set(inherited);
    for (const vars of node.arguments.slice(1, count)) {
      if (vars.type !== "ObjectExpression") return unknown();
      properties(vars, keys);
    }
    const at = node.arguments[count];
    if (at) properties(at);
    animations.push({ selector: target.value, properties: keys });
    return inherited;
  };
  for (const statement of parse(script, {
    ecmaVersion: "latest",
    sourceType: "script",
  }).body) {
    if (statement.type === "EmptyStatement") continue;
    if (
      statement.type === "VariableDeclaration" &&
      statement.kind === "const"
    ) {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          declaration.init?.type !== "CallExpression" ||
          ["gsap", "window"].includes(declaration.id.name) ||
          timelines.has(declaration.id.name)
        )
          return unknown();
        timelines.set(declaration.id.name, timeline(declaration.init, true));
      }
      continue;
    }
    if (statement.type !== "ExpressionStatement") return unknown();
    const expression = statement.expression;
    if (
      expression.type === "AssignmentExpression" &&
      expression.operator === "="
    ) {
      const destination = member(expression.left);
      if (destination === "window.__timelines") {
        // The normal HyperFrames registry initialiser. No other writes or calls are allowed.
        const value =
          expression.right.type === "LogicalExpression" &&
          expression.right.operator === "||" &&
          member(expression.right.left) === destination
            ? expression.right.right
            : expression.right;
        if (value.type !== "ObjectExpression" || value.properties.length)
          return unknown();
      } else if (destination?.startsWith("window.__timelines.")) {
        if (expression.right.type === "Identifier") {
          if (!timelines.has(expression.right.name)) return unknown();
        } else timeline(expression.right, true);
      } else return unknown();
      continue;
    }
    timeline(expression);
  }
  return animations;
}
