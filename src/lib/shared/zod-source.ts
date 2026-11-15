import { parseExpressionAt, type Node } from "acorn";
import { z } from "zod";

/**
 * Turns Zod schema *source text* (what a user types for a custom tool, e.g.
 * `z.object({ city: z.string().describe("City name") })`) into a real Zod schema
 * without evaluating it.
 *
 * The text is parsed to an AST and walked. Only method chains that start at `z`, use
 * allow-listed method names, and take literal / array / object / nested-schema arguments
 * are accepted. There are no identifiers other than `z`, no function expressions, no
 * computed access, so nothing in the text can execute.
 */

export class ZodSourceError extends Error {}

// Constructors reachable as z.<name>(...)
const BUILDERS = new Set([
  "string", "number", "boolean", "null", "any", "unknown", "literal", "enum", "object", "array", "union",
  "record", "tuple", "int", "email", "url", "uuid", "iso",
]);

// Chainable refinements reachable as <schema>.<name>(...)
const METHODS = new Set([
  "optional", "nullable", "nullish", "default", "describe", "min", "max", "length", "int", "positive", "negative",
  "nonnegative", "nonpositive", "multipleOf", "email", "url", "uuid", "regex", "startsWith", "endsWith", "includes",
  "trim", "toLowerCase", "toUpperCase", "nonempty", "strict", "partial", "date", "datetime", "time", "gt", "gte", "lt", "lte",
]);

type AnyNode = Node & Record<string, unknown>;

function fail(message: string, node?: AnyNode): never {
  throw new ZodSourceError(node && typeof node.start === "number" ? `${message} (at character ${node.start})` : message);
}

/** Evaluates a plain data literal: string, number, boolean, null, array, object, RegExp. */
function literal(node: AnyNode): unknown {
  switch (node.type) {
    case "Literal":
      if (node.regex) {
        const { pattern, flags } = node.regex as { pattern: string; flags: string };
        return new RegExp(pattern, flags);
      }
      return node.value;
    case "UnaryExpression":
      if (node.operator === "-" && (node.argument as AnyNode).type === "Literal" && typeof (node.argument as AnyNode).value === "number") {
        return -((node.argument as AnyNode).value as number);
      }
      return fail("Only negative number literals may use an operator", node);
    case "TemplateLiteral":
      if ((node.expressions as unknown[]).length === 0) return (node.quasis as { value: { cooked: string } }[])[0].value.cooked;
      return fail("Template strings with ${…} are not allowed", node);
    case "ArrayExpression":
      return (node.elements as (AnyNode | null)[]).map((el) => (el ? value(el) : fail("Array holes are not allowed", node)));
    case "ObjectExpression":
      return objectOf(node, value);
    default:
      return fail(`Unsupported expression "${node.type}"`, node);
  }
}

function objectOf(node: AnyNode, each: (n: AnyNode) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties as AnyNode[]) {
    if (prop.type !== "Property" || prop.computed || prop.kind !== "init" || prop.method) fail("Only plain `key: value` properties are allowed", prop);
    const key = prop.key as AnyNode;
    const name = key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String(key.value) : fail("Unsupported property key", key);
    if (name === "__proto__" || name === "constructor" || name === "prototype") fail(`"${name}" is not allowed as a property name`, key);
    out[name] = each(prop.value as AnyNode);
  }
  return out;
}

/** An argument: either a nested schema expression or a data literal. */
function value(node: AnyNode): unknown {
  return isSchemaExpression(node) ? schema(node) : literal(node);
}

/** True when the expression is a call chain rooted at the identifier `z`. */
function isSchemaExpression(node: AnyNode): boolean {
  let cur: AnyNode | undefined = node;
  while (cur) {
    if (cur.type === "Identifier") return cur.name === "z";
    if (cur.type === "CallExpression") cur = cur.callee as AnyNode;
    else if (cur.type === "MemberExpression") cur = cur.object as AnyNode;
    else return false;
  }
  return false;
}

type Callable = (...args: unknown[]) => unknown;

function schema(node: AnyNode): z.ZodType {
  if (node.type !== "CallExpression") fail("Expected a call such as z.string()", node);
  if (node.optional) fail("Optional calls are not allowed", node);
  const callee = node.callee as AnyNode;
  if (callee.type !== "MemberExpression" || callee.computed || callee.optional) fail("Expected a method call such as z.string()", callee);
  const name = ((callee.property as AnyNode).name as string) ?? fail("Unsupported member access", callee);
  const target = callee.object as AnyNode;
  const args = (node.arguments as AnyNode[]).map((a) => {
    if (a.type === "SpreadElement") fail("Spread arguments are not allowed", a);
    return value(a);
  });

  // z.<builder>(...) or the z.iso.<fn>() namespace
  if (target.type === "Identifier") {
    if (target.name !== "z") fail(`Unknown identifier "${target.name}". Schemas must start with z.`, target);
    if (!BUILDERS.has(name) || name === "iso") fail(`z.${name}() is not supported here`, callee);
    return (z as unknown as Record<string, Callable>)[name](...args) as z.ZodType;
  }
  if (target.type === "MemberExpression" && (target.object as AnyNode).type === "Identifier" && (target.object as AnyNode).name === "z" && ((target.property as AnyNode).name as string) === "iso") {
    if (!["date", "datetime", "time"].includes(name)) fail(`z.iso.${name}() is not supported here`, callee);
    return (z.iso as unknown as Record<string, Callable>)[name](...args) as z.ZodType;
  }

  // <schema>.<method>(...)
  if (!METHODS.has(name)) fail(`.${name}() is not supported here`, callee);
  const base = schema(target) as unknown as Record<string, Callable>;
  if (typeof base[name] !== "function") fail(`.${name}() does not exist on that schema type`, callee);
  return base[name](...args) as z.ZodType;
}

/** Parses schema source into a Zod schema. Throws ZodSourceError with a readable message. */
export function parseZodSource(source: string): z.ZodType {
  const text = source.trim().replace(/;\s*$/, "");
  if (!text) throw new ZodSourceError("The schema is empty.");
  if (text.length > 20_000) throw new ZodSourceError("The schema is too long.");
  let ast: AnyNode;
  try {
    ast = parseExpressionAt(text, 0, { ecmaVersion: "latest" }) as AnyNode;
  } catch (err) {
    throw new ZodSourceError(`Syntax error: ${(err as Error).message}`);
  }
  if ((ast.end as number) < text.length) throw new ZodSourceError("Unexpected text after the schema expression.");
  try {
    return schema(ast);
  } catch (err) {
    if (err instanceof ZodSourceError) throw err;
    // Zod itself rejected the arguments (e.g. z.enum(5)).
    throw new ZodSourceError(`Invalid schema: ${(err as Error).message}`);
  }
}

/** A tool's input must be an object schema; returns it with its JSON Schema for display. */
export function parseToolSchema(source: string): { schema: z.ZodObject; jsonSchema: Record<string, unknown> } {
  const parsed = parseZodSource(source);
  if (!(parsed instanceof z.ZodObject)) throw new ZodSourceError("A tool's input schema must be a z.object({ … }).");
  return { schema: parsed, jsonSchema: z.toJSONSchema(parsed) as Record<string, unknown> };
}
