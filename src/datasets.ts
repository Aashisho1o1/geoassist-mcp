// The three public layers this server can query. Field lists are not
// hardcoded here on purpose: the server reads them from the live layer, so
// validation always matches what the service will actually accept.
//
// Only the cities layer is an Esri Living Atlas item. The hospital and school
// layers are copies of HIFLD data hosted on ArcGIS Online by FEMA accounts.
// `source` says so in every answer, next to the date the layer was last
// edited (read live from the service), so nobody mistakes them for current,
// authoritative records.

export type DatasetId = "hospitals" | "schools" | "cities";

export interface Dataset {
  id: DatasetId;
  name: string;
  url: string;
  description: string;
  // Fields a person usually wants back (name, where it is, how to reach it).
  contactFields: string[];
  // A short note shown with every result so nobody treats the data as live.
  caveat: string;
  // Text fields with a small, fixed set of values. The server reads every
  // value of these from the layer, so filters can be checked against them.
  codedFields: string[];
  // Named sets of values that mean the same thing in a messy coded field.
  valueGroups?: ValueGroup[];
  // Where the data comes from and who hosts this copy.
  source: {
    origin: string;
    hosted_by: string;
    item_url: string;
    living_atlas: boolean;
  };
}

export interface ValueGroup {
  field: string;
  name: string;
  description: string;
  matches: (value: string) => boolean;
}

// TRAUMA is free text: 'LEVEL I', 'I', 'LEVEL 1', 'LEVEL I, PEDIATRIC II',
// 'PEDIATRIC LEVEL I' all name a Level I center. Split on anything that isn't
// a letter or digit and look for a standalone I or 1, which never matches II,
// III, or IV.
export const isLevelI = (value: string) =>
  value.toUpperCase().split(/[^A-Z0-9]+/).some((t) => t === "I" || t === "1");

// Level I for adults: the same rule, but a part of the value that names
// children ('PEDIATRIC I', 'I PEDIATRIC') does not count unless it also says
// ADULT. Parts are separated by commas. The data misspells PEDIATRIC, so the
// test is the prefix PEDIA.
export const isAdultLevelI = (value: string) =>
  value.toUpperCase().split(",").some((part) => {
    const tokens = part.split(/[^A-Z0-9]+/);
    const one = tokens.some((t) => t === "I" || t === "1");
    const child = tokens.some((t) => t.startsWith("PEDIA"));
    return one && (!child || tokens.includes("ADULT"));
  });

export const DATASETS: Record<DatasetId, Dataset> = {
  hospitals: {
    id: "hospitals",
    name: "US Hospitals",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_hifld/FeatureServer/0",
    description:
      "About 7,500 US hospitals with beds, trauma level, helipad, owner, status, and phone.",
    contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "STATUS"],
    codedFields: ["TRAUMA", "HELIPAD", "STATUS", "TYPE", "OWNER", "STATE"],
    valueGroups: [
      {
        field: "TRAUMA",
        name: "LEVEL_I",
        description:
          "Every spelling that names a Level I trauma center: any value with a standalone I or 1. " +
          "Includes centers that are Level I for children only (for example 'PEDIATRIC 1') and mixed designations (for example 'LEVEL I, PEDIATRIC II').",
        matches: isLevelI,
      },
      {
        field: "TRAUMA",
        name: "LEVEL_I_ADULT",
        description:
          "The LEVEL_I spellings that name a Level I center for adults. Leaves out values that are Level I for children only (for example 'PEDIATRIC 1').",
        matches: isAdultLevelI,
      },
    ],
    caveat:
      "Hospital status, beds, and phone numbers come from an old public snapshot of HIFLD data (its date is given with every answer), not a live or authoritative feed. A hospital listed as open may have closed. Call ahead before sending anyone. In an emergency, call 911.",
    source: {
      origin: "Homeland Infrastructure Foundation-Level Data (HIFLD) Hospitals",
      hosted_by: "FEMA Region 6 GIS (ArcGIS Online account FEMA_Region_6_GIS)",
      item_url: "https://www.arcgis.com/home/item.html?id=38eebc0197034d59b331eaa7f753cdb0",
      living_atlas: false,
    },
  },
  schools: {
    id: "schools",
    name: "US Public Schools",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Public_Schools/FeatureServer/3",
    description:
      "100,000+ US public schools with level, enrollment, grades, teachers, and phone.",
    contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "ENROLLMENT"],
    codedFields: ["LEVEL_", "STATE", "TYPE", "STATUS"],
    caveat:
      "School records come from a public copy of HIFLD data for the 2022-2023 school year (the date the copy was last edited is given with every answer). Enrollment and contact details may lag the current school year. The layer also holds schools that are closed, inactive, or not yet open (STATUS other than '1'), and nothing filters them out. Confirm with the district.",
    source: {
      origin: "Homeland Infrastructure Foundation-Level Data (HIFLD) Public Schools, from NCES Common Core of Data",
      hosted_by: "FEMA (ArcGIS Online account FEMA_HQ_Preparedness_NIC)",
      item_url: "https://www.arcgis.com/home/item.html?id=963a2d204098495a8a80134ed9dc95ae",
      living_atlas: false,
    },
  },
  cities: {
    id: "cities",
    name: "US Major Cities",
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Major_Cities_/FeatureServer/0",
    description: "About 4,200 US cities with population, population density, and a state capital flag.",
    contactFields: ["NAME", "STATE_ABBR", "POPULATION"],
    codedFields: ["CAPITAL", "CLASS", "STATE_ABBR"],
    caveat: "City populations in this layer are 2020 Census counts.",
    source: {
      origin: "USA Major Cities (Esri; US Census Bureau)",
      hosted_by: "Esri (ArcGIS Living Atlas, account esri_dm)",
      item_url: "https://www.arcgis.com/home/item.html?id=9df5e769bfe8412b8de36a2e618c7672",
      living_atlas: true,
    },
  },
};

export const DATASET_IDS = Object.keys(DATASETS) as [DatasetId, ...DatasetId[]];
