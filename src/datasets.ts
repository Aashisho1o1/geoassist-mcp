// The three Living Atlas layers GeoAssist already used. Field lists are not
// hardcoded here on purpose: the server reads them from the live layer, so
// validation always matches what the service will actually accept.

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
}

export const DATASETS: Record<DatasetId, Dataset> = {
  hospitals: {
    id: "hospitals",
    name: "US Hospitals",
    url: "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Hospitals/FeatureServer/0",
    description:
      "7,500+ US hospitals with beds, trauma level, helipad, owner, status, and phone.",
    contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "STATUS"],
    caveat:
      "Hospital status, beds, and phone numbers come from a public Living Atlas layer and can be out of date. Call ahead before sending anyone. In an emergency, call 911.",
  },
  schools: {
    id: "schools",
    name: "US Public Schools",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Public_Schools/FeatureServer/3",
    description:
      "100,000+ US public schools with level, enrollment, grades, teachers, and phone.",
    contactFields: ["NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "ENROLLMENT"],
    caveat:
      "School records come from a public Living Atlas layer. Enrollment and contact details may lag the current school year. Confirm with the district.",
  },
  cities: {
    id: "cities",
    name: "US Major Cities",
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Major_Cities_/FeatureServer/0",
    description: "Major US cities with population and household counts.",
    contactFields: ["NAME", "STATE_ABBR", "POPULATION"],
    caveat: "City populations in this layer come from US Census estimates.",
  },
};

export const DATASET_IDS = Object.keys(DATASETS) as [DatasetId, ...DatasetId[]];
