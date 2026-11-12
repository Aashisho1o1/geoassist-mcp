// Deterministic gate for model-written WHERE clauses.
//
// The model proposes a filter, this code decides whether it runs. Anything it
// doesn't recognize is rejected with a message the model can act on, so a bad
// guess turns into a corrected retry instead of a silent empty result.
const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "BETWEEN", "DATE", "TIMESTAMP"]);
const FUNCTIONS = new Set(["UPPER", "LOWER"]);
export const MAX_WHERE_LENGTH = 1000;
const isLiteral = (tok) => tok.startsWith("'");
const unquote = (tok) => tok.slice(1, -1).replace(/''/g, "'");
// A value as a SQL literal, so text in a message can be pasted back into a filter.
const sqlQuote = (v) => `'${v.replace(/'/g, "''")}'`;
const LITERAL = /'(?:[^']|'')*'/g;
const TOKEN = /\s+|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|<=|>=|<>|!=|[=<>(),]|[A-Za-z_][A-Za-z0-9_]*/y;
export function checkWhere(raw, fields) {
    const where = (raw ?? "").trim();
    if (where === "") {
        return { ok: true, where: "1=1", fields: [], comparisons: [], unread: [] };
    }
    if (where.length > MAX_WHERE_LENGTH) {
        return { ok: false, error: `WHERE clause is longer than ${MAX_WHERE_LENGTH} characters. Simplify the filter.` };
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
    const tokens = [];
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
            prev2 = prev;
            prev = tok;
            tokens.push({ tok, isField });
        }
    }
    if (depth !== 0)
        return { ok: false, error: "Unbalanced parentheses." };
    const comparisons = [];
    const unread = new Set();
    const tree = readStructure(tokens);
    if (tree)
        readConditions(tree, false, true, comparisons, unread);
    else
        for (const f of used)
            unread.add(f);
    return { ok: true, where: out.trim(), fields: [...used], comparisons, unread: [...unread] };
}
// Reads the structure with SQL precedence (NOT, then AND, then OR). A NOT
// counts here only where a condition could start, so the NOT of NOT IN,
// NOT LIKE, NOT BETWEEN and IS NOT NULL stays inside its condition. Returns
// undefined when the tokens don't form such a structure (STATE = 'CA' AND):
// the filter still goes to ArcGIS, but nothing in it is read.
function readStructure(t) {
    let i = 0;
    const list = (op, next) => {
        const items = [];
        for (;;) {
            const node = next();
            if (!node)
                return undefined;
            items.push(node);
            if (t[i]?.tok !== op)
                break;
            i++;
        }
        return items.length === 1 ? items[0] : { op, items };
    };
    const or = () => list("OR", and);
    const and = () => list("AND", unary);
    const unary = () => {
        if (t[i]?.tok === "NOT") {
            i++;
            const item = unary();
            return item && { op: "NOT", item };
        }
        if (t[i]?.tok === "(") {
            const start = i++;
            const inner = or();
            // A group only if the parenthesis closes a whole expression. Otherwise,
            // as in (BEDS) > 5, it is part of a single condition.
            if (inner && t[i]?.tok === ")" && [undefined, "AND", "OR", ")"].includes(t[i + 1]?.tok)) {
                i++;
                return inner;
            }
            i = start;
        }
        return condition();
    };
    // Tokens up to the next AND, OR or closing parenthesis at this level. The
    // AND of BETWEEN x AND y belongs to the condition, and so do the
    // parentheses of IN (...) and UPPER(...).
    const condition = () => {
        const start = i;
        let depth = 0;
        let between = false;
        for (; i < t.length; i++) {
            const tok = t[i].tok;
            if (depth === 0) {
                if (tok === "OR" || tok === ")")
                    break;
                if (tok === "AND") {
                    if (!between)
                        break;
                    between = false;
                }
                if (tok === "BETWEEN")
                    between = true;
            }
            if (tok === "(")
                depth++;
            if (tok === ")")
                depth--;
        }
        return i > start ? { op: "condition", toks: t.slice(start, i) } : undefined;
    };
    const root = or();
    return root && i === t.length ? root : undefined;
}
// Records what each condition says. `negated` is true under an odd number of
// NOTs; `required` stays true only along AND, with no OR or NOT above.
function readConditions(node, negated, required, found, unread) {
    if (node.op === "NOT")
        return readConditions(node.item, !negated, false, found, unread);
    if (node.op !== "condition") {
        for (const item of node.items)
            readConditions(item, negated, required && node.op === "AND", found, unread);
        return;
    }
    const t = node.toks;
    const c = exactComparison(t);
    if (c) {
        found.push({ ...c, negated: c.negated !== negated, required });
        return;
    }
    // FIELD IS NOT NULL only says the field has a value, so it is read. FIELD
    // IS NULL asks for rows without one and is left unread: for STATUS, adding
    // STATUS = 'OPEN' to it could only match nothing. Under NOT the two swap.
    const isNull = t.length === 3 && t[1].tok === "IS" && t[2].tok === "NULL";
    const isNotNull = t.length === 4 && t[1].tok === "IS" && t[2].tok === "NOT" && t[3].tok === "NULL";
    if (t[0].isField && (isNull || isNotNull) && isNotNull !== negated)
        return;
    for (const x of t)
        if (x.isField)
            unread.add(x.tok);
}
// The comparison a condition is, when it is nothing but one comparison of a
// field with quoted values. Only these shapes count:
//   FIELD op 'x'        'x' op FIELD        FN(FIELD) op 'x'
//   FIELD [NOT] IN ('x', ...)               FN(FIELD) [NOT] IN ('x', ...)
// where op is =, <> or != and FN is UPPER or LOWER. Anything more, such as
// STATUS = '9'-8 (which ArcGIS reads as STATUS = '1'), is not a comparison.
// Values must be plain ASCII: the layers match fullwidth and superscript forms
// too (STATUS = 'ＯＰＥＮ' finds the OPEN rows), which the value check can't.
function exactComparison(term) {
    const t = term.map((x) => x.tok);
    const lit = (i) => i < t.length && isLiteral(t[i]) && /^[\x20-\x7e]*$/.test(t[i]);
    const opAt = (i) => (t[i] === "=" ? false : t[i] === "<>" || t[i] === "!=" ? true : undefined);
    // 'x' op FIELD
    if (t.length === 3 && lit(0) && term[2].isField && opAt(1) !== undefined) {
        return { field: t[2], negated: opAt(1), values: [unquote(t[0])] };
    }
    // The field part: FIELD, or UPPER( FIELD ) / LOWER( FIELD ).
    let field;
    let i;
    if (term[0]?.isField) {
        field = t[0];
        i = 1;
    }
    else if (FUNCTIONS.has(t[0]) && t[1] === "(" && term[2]?.isField && t[3] === ")") {
        field = t[2];
        i = 4;
    }
    else
        return undefined;
    // op 'x'
    const neg = opAt(i);
    if (neg !== undefined)
        return t.length === i + 2 && lit(i + 1) ? { field, negated: neg, values: [unquote(t[i + 1])] } : undefined;
    // [NOT] IN ( 'x' , 'y' ... )
    const negated = t[i] === "NOT";
    if (negated)
        i++;
    if (t[i] !== "IN" || t[i + 1] !== "(" || t[t.length - 1] !== ")")
        return undefined;
    const inner = t.slice(i + 2, -1);
    if (inner.length === 0 || inner.length % 2 === 0)
        return undefined;
    const values = [];
    for (let k = 0; k < inner.length; k++) {
        if (k % 2 === 0 ? !isLiteral(inner[k]) : inner[k] !== ",")
            return undefined;
        if (k % 2 === 0)
            values.push(unquote(inner[k]));
    }
    return { field, negated, values };
}
// These layers compare text without regard to letter case or trailing
// spaces (STATUS = 'open' matches 'OPEN'), so the check does the same.
const fold = (v) => v.trimEnd().toUpperCase();
// Checks quoted values against fields whose full value list is known.
// FIELD = 'x' where 'x' is not in the layer can only match nothing, and an
// empty map reads as "nothing is there". So when every matching row must meet
// that comparison (`required`), the filter is refused. Anywhere else, such as
// one side of an OR, the rest of the filter may still match rows, so the same
// finding is only a warning. In an IN list, values that don't exist are
// harmless as long as one does, so they are warnings too.
export function checkValues(comparisons, schema) {
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
        if (!c.required) {
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
// STATUS <> 'OPEN', NOT (STATUS = 'OPEN'). Merely naming the field
// (STATUS IS NOT NULL) does not switch the rule off, and neither does a NOT
// that applies to another field. Decided from the conditions the gate read,
// not the raw text, so a value like NAME LIKE '%STATUS%' can't switch it off.
// If the filter uses STATUS in a form the gate can't read (STATUS LIKE 'C%',
// (STATUS) = 'CLOSED', STATUS IS NULL), adding STATUS = 'OPEN' could turn a
// valid filter into an empty one, so the rule is left off and `note` says so.
// "Open" means marked OPEN in the layer's snapshot, not open today.
//
// `statuses` is the layer's full list of STATUS values, when known. A value
// not in it (STATUS = 'OPN' OR STATE = 'TX') matches nothing, so it is not a
// request for other hospitals; the value check warns about it instead.
export function applyOpenOnly(datasetId, check, statuses) {
    if (datasetId !== "hospitals")
        return { where: check.where, applied: false };
    const isOpen = (v) => fold(v) === "OPEN";
    const status = (check.comparisons ?? []).filter((c) => c.field.toUpperCase() === "STATUS");
    // Every matching row is already OPEN (STATUS = 'OPEN' joined by AND only),
    // whatever else the filter says: nothing to add, and the answer says so.
    if (status.some((c) => c.required && !c.negated && c.values.every(isOpen))) {
        return { where: check.where, applied: true };
    }
    const unreadStatus = (check.unread ?? []).find((f) => f.toUpperCase() === "STATUS");
    if (unreadStatus) {
        return {
            where: check.where,
            applied: false,
            statusUnread: true,
            note: `The filter uses ${unreadStatus} in a form this check can't read, so hospitals not marked OPEN were not left out automatically.`,
        };
    }
    const isOther = (v) => !isOpen(v) && (!statuses || statuses.some((s) => fold(s) === fold(v)));
    if (status.some((c) => (c.negated ? c.values.some(isOpen) : c.values.some(isOther)))) {
        return { where: check.where, applied: false };
    }
    return { where: openOnlyWhere(check.where), applied: true };
}
// The filter limited to hospitals marked OPEN.
function openOnlyWhere(where) {
    return where === "1=1" ? "STATUS = 'OPEN'" : `(${where}) AND STATUS = 'OPEN'`;
}
// What to send instead when the rule was left off over an unread STATUS. The
// suggested filter has to pass the length cap too, or following it fails.
export function openOnlyAdvice(checked) {
    const suggested = openOnlyWhere(checked);
    if (suggested.length <= MAX_WHERE_LENGTH)
        return `If only open hospitals were meant, send the filter as ${suggested}.`;
    const room = MAX_WHERE_LENGTH - (suggested.length - checked.length);
    return `If only open hospitals were meant, shorten the filter to ${room} characters or fewer, then send it as (filter) AND STATUS = 'OPEN'.`;
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
