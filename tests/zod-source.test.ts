import { describe, expect, it } from "vitest";
import { parseToolSchema, parseZodSource, ZodSourceError } from "@/lib/shared/zod-source";

describe("Zod schema source parsing", () => {
  it("builds a working schema from source text", () => {
    const { schema, jsonSchema } = parseToolSchema(`z.object({
      city: z.string().min(1).describe("City name"),
      units: z.enum(["metric", "imperial"]).default("metric"),
      days: z.number().int().min(1).max(14).optional(),
      tags: z.array(z.string()).max(5).optional(),
      when: z.union([z.literal("now"), z.iso.date()]).optional(),
    })`);
    expect(schema.parse({ city: "Zurich" })).toEqual({ city: "Zurich", units: "metric" });
    expect(() => schema.parse({ city: "" })).toThrow();
    expect(() => schema.parse({ city: "x", days: 99 })).toThrow();
    expect(jsonSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["city"]), properties: { city: { description: "City name" } } });
  });

  it("supports regex, negative numbers and nested objects", () => {
    const s = parseZodSource(`z.object({ code: z.string().regex(/^[A-Z]{3}$/), delta: z.number().min(-5), nested: z.object({ ok: z.boolean() }).partial() })`);
    expect(s.safeParse({ code: "ABC", delta: -5, nested: {} }).success).toBe(true);
    expect(s.safeParse({ code: "abc", delta: 0, nested: {} }).success).toBe(false);
  });

  it("requires a tool input to be an object", () => {
    expect(() => parseToolSchema(`z.string()`)).toThrow(/must be a z\.object/);
  });

  it("rejects anything that could execute", () => {
    const attacks = [
      `process.exit(1)`,
      `z.string().refine(() => process.exit(1))`,
      `z.object({ a: z.string().transform((v) => require("fs").readFileSync(v)) })`,
      `(() => { while (true) {} })()`,
      `z.constructor.constructor("return process")()`,
      `z["string"]()`,
      `z.string().constructor("return 1")`,
      `z.object({ a: globalThis })`,
      `z.object({ [process.env.HOME]: z.string() })`,
      `z.object({ ...z })`,
      `z.string().describe(\`\${process.env.APP_SECRET}\`)`,
      `z.string(); process.exit(1)`,
      `new Function("return 1")()`,
      `z.object({ __proto__: z.string() })`,
      `z.preprocess((v) => v, z.string())`,
      `z.lazy(() => z.string())`,
      `import("node:fs")`,
    ];
    for (const src of attacks) {
      expect(() => parseZodSource(src), src).toThrow(ZodSourceError);
    }
  });

  it("gives readable errors", () => {
    expect(() => parseZodSource(``)).toThrow("The schema is empty.");
    expect(() => parseZodSource(`z.object({`)).toThrow(/Syntax error/);
    expect(() => parseZodSource(`z.strng()`)).toThrow(/z\.strng\(\) is not supported/);
    expect(() => parseZodSource(`y.string()`)).toThrow(/Unknown identifier "y"/);
    expect(() => parseZodSource(`z.string().nope()`)).toThrow(/\.nope\(\) is not supported/);
    expect(() => parseZodSource(`z.boolean().email()`)).toThrow(/does not exist on that schema type/);
  });
});
