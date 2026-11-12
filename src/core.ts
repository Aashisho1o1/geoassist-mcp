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
export { getSchema, getLayerInfo, getDataSource, findNearby, clearSchemaCache, milesBetween, arcgisRequest, MAX_GET_URL } from "./arcgis.js";
export type { FieldInfo, LayerInfo, NearbyQuery, NearbyResult } from "./arcgis.js";
export { checkWhere, checkValues, checkFields, checkOrderBy, applyOpenOnly, openOnlyAdvice, MAX_WHERE_LENGTH } from "./where.js";
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
      // True when the rule was left off because the filter uses STATUS in a
      // form the gate can't read. A note in warnings says so; callers can add
      // advice that fits their audience.
      statusUnread: boolean;
      // Values that don't exist in the layer but did not make the filter empty,
      // values that could not be checked, and why the open-only rule was left
      // off when the filter uses STATUS in a form the gate can't read.
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
  const values = checkValues(shape.comparisons, schema);
  if (!values.ok) return values;
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
