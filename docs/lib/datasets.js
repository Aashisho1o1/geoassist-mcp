// The three public layers this server can query. Field lists are not
// hardcoded here on purpose: the server reads them from the live layer, so
// validation always matches what the service will actually accept.
//
// Only the cities layer is an Esri Living Atlas item. The hospital and school
// layers are copies of HIFLD data hosted on ArcGIS Online by FEMA accounts.
// `source` says so in every answer, next to the date the layer was last
// edited (read live from the service), so nobody mistakes them for current,
// authoritative records.
// TRAUMA is free text: 'LEVEL I', 'I', 'LEVEL 1', 'LEVEL I, PEDIATRIC II',
// 'PEDIATRIC LEVEL I' all name a Level I center. Split on anything that isn't
// a letter or digit and look for a standalone I or 1, which never matches II,
// III, or IV.
export const isLevelI = (value) => value.toUpperCase().split(/[^A-Z0-9]+/).some((t) => t === "I" || t === "1");
export const DATASETS = {
    hospitals: {
        id: "hospitals",
        name: "US Hospitals",
        url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_hifld/FeatureServer/0",
        description: "About 7,500 US hospitals with beds, trauma level, helipad, owner, status, and phone.",
        contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "STATUS"],
        codedFields: ["TRAUMA", "HELIPAD", "STATUS", "TYPE", "OWNER", "STATE"],
        valueGroups: [
            {
                field: "TRAUMA",
                name: "LEVEL_I",
                description: "Every spelling that names a Level I trauma center: any value with a standalone I or 1. " +
                    "Includes centers that are Level I for children only (for example 'PEDIATRIC 1') and mixed designations (for example 'LEVEL I, PEDIATRIC II').",
                matches: isLevelI,
            },
        ],
        caveat: "Hospital status, beds, and phone numbers come from an old public snapshot of HIFLD data (its date is given with every answer), not a live or authoritative feed. A hospital listed as open may have closed. Call ahead before sending anyone. In an emergency, call 911.",
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
        description: "100,000+ US public schools with level, enrollment, grades, teachers, and phone.",
        contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "ENROLLMENT"],
        codedFields: ["LEVEL_", "STATE", "TYPE", "STATUS"],
        caveat: "School records come from a public copy of HIFLD data (its date is given with every answer). Enrollment and contact details may lag the current school year. Confirm with the district.",
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
        description: "Major US cities with population and household counts.",
        contactFields: ["NAME", "STATE_ABBR", "POPULATION"],
        codedFields: ["CAPITAL", "CLASS", "STATE_ABBR"],
        caveat: "City populations in this layer come from US Census estimates.",
        source: {
            origin: "USA Major Cities (Esri; US Census Bureau)",
            hosted_by: "Esri (ArcGIS Living Atlas, account esri_dm)",
            item_url: "https://www.arcgis.com/home/item.html?id=9df5e769bfe8412b8de36a2e618c7672",
            living_atlas: true,
        },
    },
};
export const DATASET_IDS = Object.keys(DATASETS);
