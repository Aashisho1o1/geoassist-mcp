// The shared query core: everything that decides whether a model-written
// filter may run, and reads the facts about a layer needed to decide it.
// The MCP tools, the live demo page, and the GeoAssist web app all import
// from here, so there is one safety layer and one set of tests.
//
// Nothing in this file or the modules it re-exports uses a Node-only API, so
// it runs unchanged in a browser.
import { applyOpenOnly, checkValues, checkWhere } from "./where.js";
export { DATASETS, DATASET_IDS, isLevelI, isAdultLevelI } from "./datasets.js";
export { getSchema, getLayerInfo, getDataSource, findNearby, clearSchemaCache, milesBetween, arcgisRequest, MAX_GET_URL } from "./arcgis.js";
export { checkWhere, checkValues, checkFields, checkOrderBy, applyOpenOnly, openOnlyAdvice, MAX_WHERE_LENGTH } from "./where.js";
// The whole gate in one call: field names and SQL shape, then values of coded
// fields, then the open-only default. A filter that fails any step is never sent.
export function checkFilter(ds, schema, raw, options = {}) {
    const shape = checkWhere(raw, schema.map((f) => f.name));
    if (!shape.ok)
        return shape;
    const values = checkValues(shape.comparisons, schema);
    if (!values.ok)
        return values;
    const status = schema.find((f) => f.name.toUpperCase() === "STATUS");
    let open = applyOpenOnly(ds.id, shape, status?.all_values ? status.examples : undefined);
    // With open_only: false nothing is added. The answer is still open-only
    // when the filter itself says STATUS = 'OPEN', and is labelled so.
    if (options.openOnly === false && !(open.applied && open.where === shape.where)) {
        open = { where: shape.where, applied: false };
    }
    const warnings = open.note ? [...values.warnings, open.note] : values.warnings;
    return {
        ok: true,
        where: open.where,
        checked: shape.where,
        openOnlyApplied: open.applied,
        statusUnread: Boolean(open.statusUnread),
        warnings,
    };
}
