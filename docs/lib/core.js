// The shared query core: everything that decides whether a model-written
// filter may run, and reads the facts about a layer needed to decide it.
// The MCP tools, the live demo page, and the GeoAssist web app all import
// from here, so there is one safety layer and one set of tests.
//
// Nothing in this file or the modules it re-exports uses a Node-only API, so
// it runs unchanged in a browser.
import { applyOpenOnly, checkValues, checkWhere } from "./where.js";
export { DATASETS, DATASET_IDS, isLevelI } from "./datasets.js";
export { getSchema, getLayerInfo, getDataSource, findNearby, clearSchemaCache, milesBetween } from "./arcgis.js";
export { checkWhere, checkValues, checkFields, checkOrderBy, applyOpenOnly } from "./where.js";
// The whole gate in one call: field names and SQL shape, then values of coded
// fields, then the open-only default. A filter that fails any step is never sent.
export function checkFilter(ds, schema, raw, options = {}) {
    const shape = checkWhere(raw, schema.map((f) => f.name));
    if (!shape.ok)
        return shape;
    const values = checkValues(shape.comparisons, schema);
    if (!values.ok)
        return values;
    const open = options.openOnly === false ? { where: shape.where, applied: false } : applyOpenOnly(ds.id, shape);
    return { ok: true, where: open.where, checked: shape.where, openOnlyApplied: open.applied, warnings: values.warnings };
}
