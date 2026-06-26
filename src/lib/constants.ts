import type { Station } from "@/app/types";

export const CAMBRIDGE_CRS = "CBG";

export type Terminus = {
  id: string;
  name: string;
  railCrs: string;
  tflStopId: string;
  tflStopName: string;
  interchangeMinutes: number;
  interchangeNote: string;
  /**
   * A mid-route stop (also on the Tube) that Cambridge trains call at, rather
   * than a central London terminus. Only worth boarding here when reaching it
   * beats every central terminus, so these are gated by access time.
   */
  intermediate?: boolean;
};

export const TERMINI: Terminus[] = [
  {
    id: "kings-cross",
    name: "King's Cross",
    railCrs: "KGX",
    tflStopId: "940GZZLUKSX",
    tflStopName: "King's Cross St. Pancras Underground Station",
    interchangeMinutes: 6,
    interchangeNote: "Underground platforms to King's Cross mainline concourse.",
  },
  {
    id: "st-pancras",
    name: "St Pancras",
    railCrs: "STP",
    tflStopId: "940GZZLUKSX",
    tflStopName: "King's Cross St. Pancras Underground Station",
    interchangeMinutes: 8,
    interchangeNote: "Shared King's Cross St Pancras interchange to Thameslink platforms.",
  },
  {
    id: "farringdon",
    name: "Farringdon",
    railCrs: "ZFD",
    tflStopId: "940GZZLUFCN",
    tflStopName: "Farringdon Underground Station",
    interchangeMinutes: 4,
    interchangeNote: "Underground or Elizabeth line platforms to Farringdon Thameslink platforms.",
  },
  {
    id: "liverpool-street",
    name: "Liverpool Street",
    railCrs: "LST",
    tflStopId: "940GZZLULVT",
    tflStopName: "Liverpool Street Underground Station",
    interchangeMinutes: 6,
    interchangeNote: "Underground platforms to Liverpool Street mainline concourse.",
  },
];

// Tube stations that Cambridge trains call at mid-route. For someone already
// near one of these, boarding here can beat trekking to a central terminus —
// it's the same train, so the only thing that changes is the London access leg.
export const INTERMEDIATE_RAILHEADS: Terminus[] = [
  {
    id: "finsbury-park",
    name: "Finsbury Park",
    railCrs: "FPK",
    tflStopId: "940GZZLUFPK",
    tflStopName: "Finsbury Park Underground Station",
    interchangeMinutes: 4,
    interchangeNote: "Victoria/Piccadilly line platforms to Finsbury Park National Rail platforms.",
    intermediate: true,
  },
];

// The first six are rendered as the default quick-start buttons.
export const QUICK_STATIONS: Station[] = [
  { id: "940GZZLUHR5", name: "Heathrow Terminal 5 Underground Station" },
  { id: "940GZZLUPAC", name: "Paddington Underground Station" },
  { id: "940GZZLUKSX", name: "King's Cross St. Pancras Underground Station" },
  { id: "940GZZLULVT", name: "Liverpool Street Underground Station" },
  { id: "940GZZLUOXC", name: "Oxford Circus Underground Station" },
  { id: "940GZZLUFCN", name: "Farringdon Underground Station" },
  { id: "940GZZLUEUS", name: "Euston Underground Station" },
  { id: "940GZZLUBNK", name: "Bank Underground Station" },
  { id: "940GZZLUWLO", name: "Waterloo Underground Station" },
  { id: "940GZZLULNB", name: "London Bridge Underground Station" },
  { id: "940GZZLUWSM", name: "Westminster Underground Station" },
  { id: "940GZZLUCWR", name: "Canary Wharf Underground Station" },
  { id: "940GZZLUSTD", name: "Stratford Underground Station" },
];

export const ASSUMPTIONS = [
  "Routes are ranked by Cambridge arrival time after the London access leg and station transfer buffer.",
  "TfL Journey Planner supplies Tube, walking, interchange and live status estimates for the London leg.",
  "Realtime Trains supplies live train departure and Cambridge arrival data; without RTT credentials, train data is mocked.",
  "Cambridge means Cambridge station (CBG), not Cambridge North.",
];
