// Tiny JSON-schema builders for structured outputs (all fields required, no extra props).
type S = Record<string, unknown>;

export const str = (description?: string): S => ({ type: "string", ...(description ? { description } : {}) });
export const num = (): S => ({ type: "number" });
export const int = (): S => ({ type: "integer" });
export const bool = (): S => ({ type: "boolean" });
export const en = (values: readonly string[]): S => ({ type: "string", enum: [...values] });
export const arr = (items: S): S => ({ type: "array", items });
export const obj = (properties: Record<string, S>): S => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const anyOf = (...variants: S[]): S => ({ anyOf: variants });
