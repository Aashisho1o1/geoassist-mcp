// Deterministic gate for model-written WHERE clauses.
//
// The model proposes a filter, this code decides whether it runs. Anything it
// doesn't recognize is rejected with a message the model can act on, so a bad
// guess turns into a corrected retry instead of a silent empty result.
const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "BETWEEN", "DATE", "TIMESTAMP"]);
const FUNCTIONS = new Set(["UPPER", "LOWER"]);
const MAX_LENGTH = 1000;
const isLiteral = (tok) => tok.startsWith("'");
const unquote = (tok) => tok.slice(1, -1).replace(/''/g, "'");
// A value as a SQL literal, so text in a message can be pasted back into a filter.
const sqlQuote = (v) => `'${v.replace(/'/g, "''")}'`;
const LITERAL = /'(?:[^']|'')*'/g;
const TOKEN = /\s+|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|<=|>=|<>|!=|[=<>(),]|[A-Za-z_][A-Za-z0-9_]*/y;
export function checkWhere(raw, fields) {
    const where = (raw ?? "").trim();
    if (where === "") {
        return { ok: true, where: "1=1", fields: [], comparisons: [], hasOr: false, hasNot: false, unread: [], required: [] };
    }
    if (where.length > MAX_LENGTH) {
        return { ok: false, error: `WHERE clause is longer than ${MAX_LENGTH} characters. Simplify the filter.` };
    }
    // Looked for outside quoted values only: a school named 'A--B' is a value, not a comment.
    const bare = where.replace(LITERAL, "''");
    if (bare.includes(";") || bare.includes("--") || bare.includes("/*")) {
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
    // Every field reference, and the ones a recorded shape accounted for.
    const refs = [];
    const read = [];
    // Non-space tokens with their parenthesis depth (a paren counts at the
    // depth outside it), to find the top-level AND terms afterwards.
    const tokens = [];
    let scan = { at: "none" };
    let hasOr = false;
    let hasNot = false;
    while (pos < where.length) {
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(where);
        if (!m || m.index !== pos) {
            return { ok: false, error: `Unexpected character '${where[pos]}' at position ${pos}.` };
        }
        let tok = m[0];
        pos = TOKEN.lastIndex;
        const outer = depth;
        if (tok === "(")
            depth++;
        if (tok === ")" && --depth < 0)
            return { ok: false, error: "Unbalanced parentheses." };
        if (tok === ")" && prev === "(" && prev2.toUpperCase() === "IN") {
            return { ok: false, error: "IN () needs at least one value." };
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
                refs.push(tok);
                isField = true;
            }
            else {
                const hint = closest(upper, [...byUpper.keys()]);
                return {
                    ok: false,
                    error: `Unknown field '${tok}'.` +
                        (hint ? ` Did you mean '${byUpper.get(hint)}'?` : ""),
                };
            }
        }
        out += tok;
        if (tok.trim()) {
            if (tok === "OR")
                hasOr = true;
            if (tok === "NOT" && prev !== "IS" && scan.at !== "field")
                hasNot = true;
            prev2 = prev;
            prev = tok;
            tokens.push({ tok, isField, depth: tok === ")" ? depth : outer });
            scan = step(scan, tok, isField, comparisons, read);
        }
    }
    if (depth !== 0)
        return { ok: false, error: "Unbalanced parentheses." };
    const count = (list, f) => list.filter((x) => x === f).length;
    const unread = [...used].filter((f) => count(refs, f) > count(read, f));
    return { ok: true, where: out.trim(), fields: [...used], comparisons, hasOr, hasNot, unread, required: requiredTerms(tokens) };
}
// Comparisons that make up a whole top-level AND term on their own, so every
// row the filter matches meets them. With an OR at the top level, no single
// term is required. The AND of a top-level BETWEEN is not a split point.
function requiredTerms(tokens) {
    const top = tokens.filter((t) => t.depth === 0);
    if (top.some((t) => t.tok === "OR"))
        return [];
    const terms = [[]];
    let between = false;
    for (const t of tokens) {
        if (t.depth === 0 && t.tok === "BETWEEN")
            between = true;
        if (t.depth === 0 && t.tok === "AND") {
            if (between)
                between = false;
            else {
                terms.push([]);
                continue;
            }
        }
        terms[terms.length - 1].push(t);
    }
    const required = [];
    for (let term of terms) {
        // Drop parentheses that wrap the whole term: ((STATUS = 'OPEN')).
        while (term.length > 2 && term[0].tok === "(" && closes(term) === term.length - 1)
            term = term.slice(1, -1);
        if (!term.length || term[0].tok === "NOT")
            continue;
        const found = [];
        let scan = { at: "none" };
        let doneAt = -1;
        term.forEach((t, i) => {
            const before = found.length;
            scan = step(scan, t.tok, t.isField, found, []);
            if (found.length > before)
                doneAt = i;
        });
        // The term is exactly one comparison: it ends on the token that completed it.
        if (found.length === 1 && doneAt === term.length - 1 && term.filter((t) => t.isField).length === 1) {
            required.push(found[0]);
        }
    }
    return required;
}
// Index of the parenthesis that closes the one at index 0.
function closes(term) {
    let d = 0;
    for (let i = 0; i < term.length; i++) {
        if (term[i].tok === "(")
            d++;
        if (term[i].tok === ")" && --d === 0)
            return i;
    }
    return -1;
}
// Advance the comparison scan by one token, recording a comparison when a
// "FIELD = 'x'", "'x' = FIELD" or "FIELD IN ('x', ...)" shape completes. Each
// field reference a shape accounts for (those, and FIELD IS [NOT] NULL) is
// added to `read`.
function step(scan, tok, isField, found, read) {
    const fresh = isField
        ? { at: "field", field: tok }
        : FUNCTIONS.has(tok)
            ? { at: "fn" }
            : isLiteral(tok)
                ? { at: "lit", value: unquote(tok) }
                : { at: "none" };
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
            if (tok === "IS")
                return { at: "is", field: scan.field, not: false };
            return fresh;
        case "is":
            if (tok === "NOT" && !scan.not)
                return { ...scan, not: true };
            // FIELD IS NOT NULL only says the field has a value, so it is read.
            // FIELD IS NULL asks for rows without one and is left unread: for
            // STATUS, adding STATUS = 'OPEN' to it could only match nothing.
            if (tok === "NULL" && scan.not)
                read.push(scan.field);
            return tok === "NULL" ? { at: "none" } : fresh;
        case "not":
            if (tok === "IN")
                return { at: "in", field: scan.field, negated: true, open: false, values: [] };
            return fresh;
        case "op":
            if (!isLiteral(tok))
                return fresh;
            found.push({ field: scan.field, negated: scan.negated, values: [unquote(tok)] });
            read.push(scan.field);
            return { at: "none" };
        case "in":
            if (!scan.open)
                return tok === "(" ? { ...scan, open: true } : fresh;
            if (isLiteral(tok))
                return { ...scan, values: [...scan.values, unquote(tok)] };
            if (tok === ",")
                return scan;
            if (tok === ")" && scan.values.length) {
                found.push({ field: scan.field, negated: scan.negated, values: scan.values });
                read.push(scan.field);
            }
            return tok === ")" ? { at: "none" } : fresh;
        case "fn":
            return tok === "(" ? { at: "fnOpen" } : fresh;
        case "fnOpen":
            return isField ? { at: "fnField", field: tok } : fresh;
        case "fnField":
            return tok === ")" ? { at: "field", field: scan.field } : fresh;
        case "lit":
            if (tok === "=")
                return { at: "litOp", value: scan.value, negated: false };
            if (tok === "<>" || tok === "!=")
                return { at: "litOp", value: scan.value, negated: true };
            return fresh;
        case "litOp":
            if (!isField)
                return fresh;
            found.push({ field: tok, negated: scan.negated, values: [scan.value] });
            read.push(tok);
            return { at: "none" };
        default:
            return fresh;
    }
}
// These layers compare text without regard to letter case or trailing
// spaces (STATUS = 'open' matches 'OPEN'), so the check does the same.
const fold = (v) => v.trimEnd().toUpperCase();
// Checks quoted values against fields whose full value list is known.
// FIELD = 'x' where 'x' is not in the layer can only match nothing, and an
// empty map reads as "nothing is there". So when every condition is joined by
// AND (`provable`), such a filter is refused. With OR or NOT in the filter the
// rest of it may still match rows, so the same finding is only a warning. In
// an IN list, values that don't exist are harmless as long as one does, so
// they are warnings too.
export function checkValues(comparisons, schema, provable = true) {
    const warnings = [];
    for (const c of comparisons) {
        const field = schema.find((f) => f.name === c.field);
        if (!field || c.negated)
            continue;
        if (field.values_unavailable) {
            warnings.push(`The values of ${c.field} could not be read from the layer just now, so ${c.values.map(sqlQuote).join(", ")} was not checked. If nothing matches, the value may not exist.`);
            continue;
        }
        if (!field.all_values)
            continue;
        const known = new Set(field.examples.map(fold));
        const missing = c.values.filter((v) => !known.has(fold(v)));
        if (missing.length === 0)
            continue;
        const quoted = missing.map(sqlQuote).join(", ");
        const isNot = `${quoted} ${missing.length === 1 ? "is not a value" : "are not values"} of ${c.field} in this layer`;
        if (missing.length < c.values.length) {
            warnings.push(`${isNot} and matched nothing. The other values in the list were used.`);
            continue;
        }
        const near = closestValue(fold(missing[0]), [...known]);
        const hint = (near !== undefined ? ` Did you mean ${sqlQuote(field.examples.find((v) => fold(v) === near))}?` : "") +
            (field.examples.length <= 12
                ? ` Values in the layer: ${field.examples.map(sqlQuote).join(", ")}.`
                : near === undefined
                    ? ` ${c.field} has ${field.examples.length} values in the layer and none is a near match.`
                    : "");
        if (!provable) {
            warnings.push(`${isNot}, so that part of the filter matches nothing.${hint}`);
            continue;
        }
        return { ok: false, error: `${isNot}, so the filter would match nothing.${hint}` };
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
// Leave out hospitals that are not marked OPEN, unless the filter itself asks
// for another status: STATUS = 'CLOSED', STATUS IN ('OPEN', 'CLOSED'),
// STATUS <> 'OPEN'. Merely naming the field (STATUS IS NOT NULL) does not
// switch the rule off. Decided from the comparisons the gate parsed, not the
// raw text, so a value like NAME LIKE '%STATUS%' can't switch it off either.
// If the filter uses STATUS in a form the gate can't read (STATUS LIKE 'C%',
// (STATUS) = 'CLOSED', STATUS IS NULL), adding STATUS = 'OPEN' could turn a
// valid filter into an empty one, so the rule is left off and `note` says so.
// "Open" means marked OPEN in the layer's snapshot, not open today.
export function applyOpenOnly(datasetId, check) {
    if (datasetId !== "hospitals")
        return { where: check.where, applied: false };
    const isStatus = (f) => f.toUpperCase() === "STATUS";
    const isOpen = (v) => fold(v) === "OPEN";
    // Every matching row is already OPEN (a top-level AND STATUS = 'OPEN'),
    // whatever else the filter says: nothing to add, and the answer says so.
    if ((check.required ?? []).some((c) => isStatus(c.field) && !c.negated && c.values.every(isOpen))) {
        return { where: check.where, applied: true };
    }
    const unreadStatus = (check.unread ?? []).find(isStatus);
    if (unreadStatus) {
        return {
            where: check.where,
            applied: false,
            statusUnread: true,
            note: `The filter uses ${unreadStatus} in a form this check can't read, so hospitals not marked OPEN were not left out automatically.`,
        };
    }
    const status = (check.comparisons ?? []).filter((c) => isStatus(c.field));
    const asksForOther = status.some((c) => (c.negated ? c.values.some(isOpen) : !c.values.every(isOpen))) ||
        // NOT (STATUS = 'OPEN') or NOT (STATUS IS NOT NULL) asks for the others.
        (Boolean(check.hasNot) && (check.fields ?? status.map((c) => c.field)).some(isStatus));
    if (asksForOther)
        return { where: check.where, applied: false };
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
// Nearest value for a "Did you mean" hint. Short codes get no slack (every
// two-letter state code is one or two edits from many others), and a tie
// gives no hint: a wrong suggestion is worse than none.
function closestValue(word, options) {
    const allowed = word.length <= 2 ? 0 : word.length <= 5 ? 1 : 2;
    let best;
    let bestD = allowed + 1;
    let tied = false;
    for (const o of options) {
        const d = distance(word, o);
        if (d < bestD) {
            bestD = d;
            best = o;
            tied = false;
        }
        else if (d === bestD) {
            tied = true;
        }
    }
    return tied ? undefined : best;
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
