// Deterministic gate for model-written WHERE clauses.
//
// The model proposes a filter, this code decides whether it runs. Anything it
// doesn't recognize is rejected with a message the model can act on, so a bad
// guess turns into a corrected retry instead of a silent empty result.
const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "BETWEEN", "DATE", "TIMESTAMP"]);
const FUNCTIONS = new Set(["UPPER", "LOWER"]);
const MAX_LENGTH = 500;
const isLiteral = (tok) => tok.startsWith("'");
const unquote = (tok) => tok.slice(1, -1).replace(/''/g, "'");
const TOKEN = /\s+|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|<=|>=|<>|!=|[=<>(),]|[A-Za-z_][A-Za-z0-9_]*/y;
export function checkWhere(raw, fields) {
    const where = (raw ?? "").trim();
    if (where === "")
        return { ok: true, where: "1=1", fields: [], comparisons: [] };
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
    const used = new Set();
    // Last two non-space tokens, to catch an empty IN () list.
    let prev = "";
    let prev2 = "";
    const comparisons = [];
    let scan = { at: "none" };
    while (pos < where.length) {
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(where);
        if (!m || m.index !== pos) {
            return { ok: false, error: `Unexpected character '${where[pos]}' at position ${pos}.` };
        }
        let tok = m[0];
        pos = TOKEN.lastIndex;
        if (tok === "(")
            depth++;
        if (tok === ")" && --depth < 0)
            return { ok: false, error: "Unbalanced parentheses." };
        if (tok === ")" && prev === "(" && prev2.toUpperCase() === "IN") {
            return { ok: false, error: "IN () needs at least one value. Call get_dataset_schema to see the values in the layer." };
        }
        let isField = false;
        if (/^[A-Za-z_]/.test(tok)) {
            const upper = tok.toUpperCase();
            if (KEYWORDS.has(upper) || FUNCTIONS.has(upper)) {
                tok = upper;
            }
            else if (byUpper.has(upper)) {
                tok = byUpper.get(upper); // canonical field spelling
                used.add(tok);
                isField = true;
            }
            else {
                const hint = closest(upper, [...byUpper.keys()]);
                return {
                    ok: false,
                    error: `Unknown field '${tok}'.` +
                        (hint ? ` Did you mean '${byUpper.get(hint)}'?` : "") +
                        " Call get_dataset_schema to see valid fields.",
                };
            }
        }
        out += tok;
        if (tok.trim()) {
            prev2 = prev;
            prev = tok;
            scan = step(scan, tok, isField, comparisons);
        }
    }
    if (depth !== 0)
        return { ok: false, error: "Unbalanced parentheses." };
    return { ok: true, where: out.trim(), fields: [...used], comparisons };
}
// Advance the comparison scan by one token, recording a comparison when a
// "FIELD = 'x'" or "FIELD IN ('x', ...)" shape completes.
function step(scan, tok, isField, found) {
    const fresh = isField ? { at: "field", field: tok } : { at: "none" };
    switch (scan.at) {
        case "field":
            if (tok === "=")
                return { at: "op", field: scan.field, negated: false };
            if (tok === "<>" || tok === "!=")
                return { at: "op", field: scan.field, negated: true };
            if (tok === "NOT")
                return { at: "not", field: scan.field };
            if (tok === "IN")
                return { at: "in", field: scan.field, negated: false, open: false, values: [] };
            return fresh;
        case "not":
            if (tok === "IN")
                return { at: "in", field: scan.field, negated: true, open: false, values: [] };
            return fresh;
        case "op":
            if (isLiteral(tok))
                found.push({ field: scan.field, negated: scan.negated, values: [unquote(tok)] });
            return fresh;
        case "in":
            if (!scan.open)
                return tok === "(" ? { ...scan, open: true } : fresh;
            if (isLiteral(tok))
                return { ...scan, values: [...scan.values, unquote(tok)] };
            if (tok === ",")
                return scan;
            if (tok === ")" && scan.values.length)
                found.push({ field: scan.field, negated: scan.negated, values: scan.values });
            return fresh;
        default:
            return fresh;
    }
}
// These layers compare text without regard to letter case or trailing
// spaces (STATUS = 'open' matches 'OPEN'), so the check does the same.
const fold = (v) => v.trimEnd().toUpperCase();
// Checks quoted values against fields whose full value list is known.
// FIELD = 'x' where 'x' is not in the layer is refused: it can only return
// nothing, and an empty map reads as "nothing is there". In an IN list, values
// that don't exist are harmless as long as one does, so they become warnings.
export function checkValues(comparisons, schema) {
    const warnings = [];
    for (const c of comparisons) {
        const field = schema.find((f) => f.name === c.field);
        if (!field?.all_values || c.negated)
            continue;
        const known = new Set(field.examples.map(fold));
        const missing = c.values.filter((v) => !known.has(fold(v)));
        if (missing.length === 0)
            continue;
        const quoted = missing.map((v) => `'${v}'`).join(", ");
        if (missing.length === c.values.length) {
            const near = closest(fold(missing[0]), [...known]);
            const list = field.examples.length <= 12 ? ` Values in the layer: ${field.examples.map((v) => `'${v}'`).join(", ")}.` : "";
            return {
                ok: false,
                error: `${quoted} ${missing.length === 1 ? "is not a value" : "are not values"} of ${c.field} in this layer, so the filter would match nothing.` +
                    (near ? ` Did you mean '${field.examples.find((v) => fold(v) === near)}'?` : "") +
                    list +
                    " Call get_dataset_schema to see every value.",
            };
        }
        warnings.push(`${quoted} ${missing.length === 1 ? "is not a value" : "are not values"} of ${c.field} in this layer and matched nothing. The other values in the list were used.`);
    }
    return { ok: true, warnings };
}
// ORDER BY may only be "FIELD", "FIELD ASC" or "FIELD DESC", comma separated.
export function checkOrderBy(raw, fields) {
    const byUpper = new Map(fields.map((f) => [f.toUpperCase(), f]));
    const parts = [];
    for (const part of (raw ?? "").split(",")) {
        const [field, direction, ...rest] = part.trim().split(/\s+/);
        if (!field)
            continue;
        const hit = byUpper.get(field.toUpperCase());
        if (!hit) {
            const hint = closest(field.toUpperCase(), [...byUpper.keys()]);
            return { ok: false, error: `Unknown sort field '${field}'.` + (hint ? ` Did you mean '${byUpper.get(hint)}'?` : "") };
        }
        if (rest.length || (direction && !/^(ASC|DESC)$/i.test(direction))) {
            return { ok: false, error: `Invalid ORDER BY "${part.trim()}". Use a field name with ASC or DESC.` };
        }
        parts.push(direction ? `${hit} ${direction.toUpperCase()}` : hit);
    }
    return { ok: true, orderBy: parts.join(", ") };
}
// Leave closed hospitals out unless the filter already says something about
// STATUS. Decided from the field names the gate saw, not the raw text, so a
// value like NAME LIKE '%STATUS%' can't switch the safety default off.
export function applyOpenOnly(datasetId, check) {
    if (datasetId !== "hospitals" || check.fields.some((f) => f.toUpperCase() === "STATUS")) {
        return { where: check.where, applied: false };
    }
    const where = check.where === "1=1" ? "STATUS = 'OPEN'" : `(${check.where}) AND STATUS = 'OPEN'`;
    return { where, applied: true };
}
// Requested output fields must exist. Default fields are always added so a
// result never comes back without a name and a way to reach the place.
export function checkFields(requested, fields, defaults) {
    const byUpper = new Map(fields.map((f) => [f.toUpperCase(), f]));
    const list = [];
    for (const f of requested ?? []) {
        const hit = byUpper.get(f.trim().toUpperCase());
        if (!hit) {
            const hint = closest(f.trim().toUpperCase(), [...byUpper.keys()]);
            return {
                ok: false,
                error: `Unknown output field '${f}'.` + (hint ? ` Did you mean '${byUpper.get(hint)}'?` : ""),
            };
        }
        if (!list.includes(hit))
            list.push(hit);
    }
    for (const d of defaults) {
        const hit = byUpper.get(d.toUpperCase());
        if (hit && !list.includes(hit))
            list.push(hit);
    }
    return { ok: true, list };
}
// Small edit-distance helper so error messages can point at the right field.
function closest(word, options) {
    let best;
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
function distance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
}
