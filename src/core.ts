// The shared query core: everything that decides whether a model-written
// filter may run, and reads the facts about a layer needed to decide it.
// The MCP tools, the live demo page, and the GeoAssist web app all import
// from here, so there is one safety layer and one set of tests.
//
// Nothing in this file or the modules it re-exports uses a Node-only API, so
// it runs unchanged in a browser.

import type { Dataset } from "./datasets.js";
import type { FieldInfo } from "./arcgis.js";
import { applyOpenOnly, checkValues, checkWhere } from "./where.js";

export { DATASETS, DATASET_IDS, isLevelI, isAdultLevelI } from "./datasets.js";
export type { Dataset, DatasetId, ValueGroup } from "./datasets.js";
export { getSchema, getLayerInfo, getDataSource, findNearby, clearSchemaCache, milesBetween } from "./arcgis.js";
export type { FieldInfo, LayerInfo, NearbyQuery, NearbyResult } from "./arcgis.js";
export { checkWhere, checkValues, checkFields, checkOrderBy, applyOpenOnly } from "./where.js";
export type { WhereCheck, ValueCheck, FieldCheck, OrderCheck, Comparison } from "./where.js";

export type FilterCheck =
  | {
      ok: true;
      // The filter to send: canonical field spelling, plus the open-only rule.
      where: string;
      // The filter as checked, before the open-only rule was added.
      checked: string;
      // True when the answer is limited to hospitals marked OPEN: the rule was
      // added, or the filter already said STATUS = 'OPEN'.
      openOnlyApplied: boolean;
      // Values that don't exist in the layer but did not make the filter empty,
      // and values that could not be checked.
      warnings: string[];
    }
  | { ok: false; error: string };

// The whole gate in one call: field names and SQL shape, then values of coded
// fields, then the open-only default. A filter that fails any step is never sent.
export function checkFilter(
  ds: Dataset,
  schema: FieldInfo[],
  raw: string | undefined,
  options: { openOnly?: boolean } = {},
): FilterCheck {
  const shape = checkWhere(raw, schema.map((f) => f.name));
  if (!shape.ok) return shape;
  const values = checkValues(shape.comparisons, schema, !shape.hasOr && !shape.hasNot);
  if (!values.ok) return values;
  const open = options.openOnly === false ? { where: shape.where, applied: false } : applyOpenOnly(ds.id, shape);
  return { ok: true, where: open.where, checked: shape.where, openOnlyApplied: open.applied, warnings: values.warnings };
}
