// Deterministic gate for model-written WHERE clauses.
//
// The model proposes a filter, this code decides whether it runs. Anything it
// doesn't recognize is rejected with a message the model can act on, so a bad
// guess turns into a corrected retry instead of a silent empty result.

const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "BETWEEN", "DATE", "TIMESTAMP"]);
const FUNCTIONS = new Set(["UPPER", "LOWER"]);
const MAX_LENGTH = 500;

export type WhereCheck =
  | { ok: true; where: string }
  | { ok: false; error: string };

const TOKEN =
  /\s+|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|<=|>=|<>|!=|[=<>(),]|[A-Za-z_][A-Za-z0-9_]*/y;

export function checkWhere(raw: string | undefined, fields: string[]): WhereCheck {
  const where = (raw ?? "").trim();
  if (where === "") return { ok: true, where: "1=1" };
  if (where.length > MAX_LENGTH) {
    return { ok: false, error: `WHERE clause is longer than ${MAX_LENGTH} characters. Simplify the filter.` };
  }
  if (where.includes(";") || where.includes("--") || where.includes("/*")) {
    return { ok: false, error: "WHERE clause may not contain ';', '--', or '/*'. Use a single filter expression." };
  }

  const byUpper = new Map(fields.map((f) => [f.toUpperCase(), f]));
  let depth = 0;
  let pos = 0;
  let out = "";

  while (pos < where.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(where);
    if (!m || m.index !== pos) {
      return { ok: false, error: `Unexpected character '${where[pos]}' at position ${pos}.` };
    }
    let tok = m[0];
    pos = TOKEN.lastIndex;

    if (tok === "(") depth++;
    if (tok === ")" && --depth < 0) return { ok: false, error: "Unbalanced parentheses." };

    if (/^[A-Za-z_]/.test(tok)) {
      const upper = tok.toUpperCase();
      if (KEYWORDS.has(upper) || FUNCTIONS.has(upper)) {
        tok = upper;
      } else if (byUpper.has(upper)) {
        tok = byUpper.get(upper)!; // canonical field spelling
      } else {
        const hint = closest(upper, [...byUpper.keys()]);
        return {
          ok: false,
          error:
            `Unknown field '${tok}'.` +
            (hint ? ` Did you mean '${byUpper.get(hint)}'?` : "") +
            " Call get_dataset_schema to see valid fields.",
        };
      }
    }
    out += tok;
  }

  if (depth !== 0) return { ok: false, error: "Unbalanced parentheses." };
  return { ok: true, where: out.trim() };
}

export type FieldCheck =
  | { ok: true; list: string[] }
  | { ok: false; error: string };

// Requested output fields must exist. Default fields are always added so a
// result never comes back without a name and a way to reach the place.
export function checkFields(requested: string[] | undefined, fields: string[], defaults: string[]): FieldCheck {
  const byUpper = new Map(fields.map((f) => [f.toUpperCase(), f]));
  const list: string[] = [];
  for (const f of requested ?? []) {
    const hit = byUpper.get(f.trim().toUpperCase());
    if (!hit) {
      const hint = closest(f.trim().toUpperCase(), [...byUpper.keys()]);
      return {
        ok: false,
        error: `Unknown output field '${f}'.` + (hint ? ` Did you mean '${byUpper.get(hint)}'?` : ""),
      };
    }
    if (!list.includes(hit)) list.push(hit);
  }
  for (const d of defaults) {
    const hit = byUpper.get(d.toUpperCase());
    if (hit && !list.includes(hit)) list.push(hit);
  }
  return { ok: true, list };
}

// Small edit-distance helper so error messages can point at the right field.
function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}
