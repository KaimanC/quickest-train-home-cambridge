import type { TrainOption } from "@/app/types";
import { CAMBRIDGE_CRS, type Terminus } from "@/lib/constants";
import {
  addMinutes,
  parseLegacyTime,
  parseRttDateTime,
  toIso,
  ymdInLondon,
} from "@/lib/time";

const CANDIDATES_PER_TERMINUS = 3;
const DETAIL_CANDIDATES_PER_TERMINUS = 2;
const DEFAULT_LOOKAHEAD_MINUTES = 720;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const RTT_RESPONSE_CACHE_MS = 45_000;

type RttMode = "mock" | "token" | "basic";

type CachedRttAccessToken = {
  token: string;
  validUntilMs: number;
};

type RttAccessTokenResponse = {
  accessToken?: string;
  token?: string;
  validUntil?: string;
};

let cachedRttAccessToken: CachedRttAccessToken | undefined;
const rttResponseCache = new Map<string, { expiresAt: number; data: unknown }>();

type RttTemporal = {
  scheduleAdvertised?: string | null;
  scheduleInternal?: string | null;
  realtimeForecast?: string | null;
  realtimeEstimate?: string | null;
  realtimeActual?: string | null;
  realtimeAdvertisedLateness?: number | null;
  isCancelled?: boolean;
};

type RttLineupService = {
  temporalData?: {
    departure?: RttTemporal;
    arrival?: RttTemporal;
    displayAs?: string | null;
  };
  locationMetadata?: {
    platform?: { planned?: string | null; forecast?: string | null; actual?: string | null };
  };
  scheduleMetadata?: {
    uniqueIdentity?: string;
    identity?: string;
    departureDate?: string;
    operator?: { name?: string; code?: string };
    inPassengerService?: boolean;
  };
  origin?: RttLocationPair[];
  destination?: RttLocationPair[];
};

type RttLocationPair = {
  location?: {
    description?: string;
    shortCodes?: string[];
    longCodes?: string[];
  };
  temporalData?: RttTemporal;
};

type RttServiceDetail = {
  service?: {
    locations?: {
      location?: {
        description?: string;
        shortCodes?: string[];
        longCodes?: string[];
      };
      temporalData?: {
        arrival?: RttTemporal;
        departure?: RttTemporal;
      };
    }[];
  };
};

type LegacyBoardService = {
  serviceUid?: string;
  runDate?: string;
  atocName?: string;
  destination?: { description?: string; publicTime?: string }[];
  locationDetail?: {
    gbttBookedDeparture?: string;
    realtimeDeparture?: string;
    realtimeGbttDepartureLateness?: number | null;
    platform?: string;
    displayAs?: string;
  };
};

type LegacyServiceDetail = {
  locations?: {
    crs?: string;
    description?: string;
    gbttBookedArrival?: string;
    realtimeArrival?: string;
    realtimeGbttArrivalLateness?: number | null;
  }[];
};

export function usingMockRtt() {
  return getRttMode() === "mock";
}

type DepartureOptions = {
  notBefore?: Date;
  /** Plan around this time instead of now (depart-at feature). */
  searchTime?: Date;
};

export async function getCambridgeDepartures(
  terminus: Terminus,
  options: DepartureOptions = {},
) {
  const mode = getRttMode();
  if (mode === "mock") return mockDepartures(terminus, options.searchTime);
  if (mode === "basic") return getLegacyDepartures(terminus, options);
  return getTokenDepartures(terminus, options);
}

async function getTokenDepartures(terminus: Terminus, options: DepartureOptions) {
  const params: Record<string, string | undefined> = {
    code: terminus.railCrs,
    filterTo: CAMBRIDGE_CRS,
    timeWindow: rttLookaheadMinutes().toString(),
    timeTolerance: "true",
  };

  // The API caps timeWindow at 23h59m, so a future depart-at time can't be
  // reached by widening the window from "now". Anchor the board at that time
  // with timeFrom instead and keep timeWindow at its normal lookahead.
  if (options.searchTime && options.searchTime.getTime() > Date.now()) {
    params.timeFrom = toIso(options.searchTime);
  }

  const board = await rttTokenFetch<{ services?: RttLineupService[] }>("/gb-nr/location", params);

  const candidates = (board.services ?? [])
    .filter((service) => service.scheduleMetadata?.inPassengerService !== false)
    .filter((service) => !service.temporalData?.departure?.isCancelled)
    .filter((service) => isCatchableService(service, options.notBefore))
    .slice(0, CANDIDATES_PER_TERMINUS);

  const trains: (TrainOption | undefined)[] = [];
  for (const service of candidates.slice(0, DETAIL_CANDIDATES_PER_TERMINUS)) {
    trains.push(await enrichTokenService(service, terminus));
  }

  return trains
    .filter((train): train is TrainOption => Boolean(train))
    .sort((a, b) => Date.parse(a.departureTime) - Date.parse(b.departureTime));
}

async function enrichTokenService(
  service: RttLineupService,
  terminus: Terminus,
): Promise<TrainOption | undefined> {
  const departure = pickTemporalDate(service.temporalData?.departure);
  if (!departure) return undefined;

  const boardCambridge = service.destination?.find(isCambridgeLocationPair);
  const boardArrival = pickTemporalDate(boardCambridge?.temporalData);
  const cambridge = boardArrival ? undefined : await getServiceCambridgeCall(service);
  const arrival = boardArrival ?? pickTemporalDate(cambridge?.temporalData?.arrival);
  if (!arrival) return undefined;

  const delayMinutes =
    service.temporalData?.departure?.realtimeAdvertisedLateness ??
    cambridge?.temporalData?.arrival?.realtimeAdvertisedLateness ??
    undefined;

  return {
    serviceId:
      service.scheduleMetadata?.identity ??
      service.scheduleMetadata?.uniqueIdentity ??
      `${terminus.railCrs}-${departure.toISOString()}`,
    terminusId: terminus.id,
    terminusName: terminus.name,
    crs: terminus.railCrs,
    operator:
      service.scheduleMetadata?.operator?.name ??
      service.scheduleMetadata?.operator?.code ??
      "Unknown operator",
    destinationName: readableDestination(service.destination),
    departureTime: toIso(departure),
    arrivalTime: toIso(arrival),
    platform: pickPlatform(service),
    status: statusText(delayMinutes, service.temporalData?.departure?.isCancelled),
    delayMinutes: delayMinutes ?? undefined,
    isCancelled: service.temporalData?.departure?.isCancelled,
  } satisfies TrainOption;
}

async function getServiceCambridgeCall(service: RttLineupService) {
  const detail = await rttTokenFetch<RttServiceDetail>("/gb-nr/service", serviceParams(service));
  return detail.service?.locations?.find((location) => {
    const shortCodes = location.location?.shortCodes ?? [];
    const description = location.location?.description?.toLowerCase() ?? "";
    return shortCodes.includes(CAMBRIDGE_CRS) || description === "cambridge";
  });
}

async function getLegacyDepartures(terminus: Terminus, options: DepartureOptions) {
  const board = await rttLegacyFetch<{ services?: LegacyBoardService[] }>(
    `/json/search/${terminus.railCrs}/to/${CAMBRIDGE_CRS}`,
  );

  const services = (board.services ?? [])
    .filter((service) => service.locationDetail?.displayAs !== "CANCELLED_CALL")
    .filter((service) => isCatchableLegacyService(service, options.notBefore))
    .slice(0, CANDIDATES_PER_TERMINUS);

  const trains = await Promise.all(
    services.map((service) => enrichLegacyService(service, terminus)),
  );

  return trains
    .filter((train): train is TrainOption => Boolean(train))
    .sort((a, b) => Date.parse(a.departureTime) - Date.parse(b.departureTime));
}

async function enrichLegacyService(
  service: LegacyBoardService,
  terminus: Terminus,
): Promise<TrainOption | undefined> {
  if (!service.serviceUid || !service.runDate) return undefined;

  const departure = parseLegacyTime(
    service.runDate,
    service.locationDetail?.realtimeDeparture ?? service.locationDetail?.gbttBookedDeparture,
  );
  if (!departure) return undefined;

  const [year, month, day] = service.runDate.split("-");
  const detail = await rttLegacyFetch<LegacyServiceDetail>(
    `/json/service/${service.serviceUid}/${year}/${month}/${day}`,
  );
  const cambridge = detail.locations?.find(
    (location) =>
      location.crs === CAMBRIDGE_CRS ||
      location.description?.toLowerCase() === "cambridge",
  );
  const arrival = parseLegacyTime(
    service.runDate,
    cambridge?.realtimeArrival ?? cambridge?.gbttBookedArrival,
    departure,
  );
  if (!arrival) return undefined;

  const delayMinutes =
    cambridge?.realtimeGbttArrivalLateness ??
    service.locationDetail?.realtimeGbttDepartureLateness ??
    undefined;

  return {
    serviceId: service.serviceUid,
    terminusId: terminus.id,
    terminusName: terminus.name,
    crs: terminus.railCrs,
    operator: service.atocName ?? "Unknown operator",
    destinationName: service.destination?.[0]?.description ?? "Cambridge",
    departureTime: toIso(departure),
    arrivalTime: toIso(arrival),
    platform: service.locationDetail?.platform,
    status: statusText(delayMinutes),
    delayMinutes: delayMinutes ?? undefined,
  } satisfies TrainOption;
}

async function rttTokenFetch<T>(path: string, params: Record<string, string | undefined>) {
  const url = new URL(path, process.env.RTT_API_BASE_URL ?? "https://data.rtt.io");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const cacheKey = url.toString();
  const cached = rttResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data as T;
  }

  const token = await getRttBearerToken();

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    next: { revalidate: 45 },
  });

  if (response.status === 204) return {} as T;
  if (!response.ok) throw new Error(`Realtime Trains failed (${response.status}).`);

  const data = (await response.json()) as T;
  rttResponseCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + RTT_RESPONSE_CACHE_MS,
  });

  return data;
}

async function getRttBearerToken() {
  const directAccessToken = process.env.RTT_ACCESS_TOKEN;
  if (directAccessToken) return directAccessToken;

  const refreshToken = process.env.RTT_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("RTT_REFRESH_TOKEN or RTT_ACCESS_TOKEN is not configured.");
  }

  if (
    cachedRttAccessToken &&
    cachedRttAccessToken.validUntilMs - TOKEN_REFRESH_BUFFER_MS > Date.now()
  ) {
    return cachedRttAccessToken.token;
  }

  const url = new URL(
    "/api/get_access_token",
    process.env.RTT_API_BASE_URL ?? "https://data.rtt.io",
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Realtime Trains token exchange failed (${response.status}).`);
  }

  const payload = (await response.json()) as RttAccessTokenResponse;
  const accessToken = payload.accessToken ?? payload.token;
  if (!accessToken || !payload.validUntil) {
    throw new Error("Realtime Trains token exchange returned an unexpected response.");
  }

  cachedRttAccessToken = {
    token: accessToken,
    validUntilMs: Date.parse(payload.validUntil),
  };

  return cachedRttAccessToken.token;
}

async function rttLegacyFetch<T>(path: string) {
  const base = process.env.RTT_LEGACY_BASE_URL ?? "https://api.rtt.io/api/v1";
  const url = new URL(path, base);
  const username = process.env.RTT_BASIC_USERNAME;
  const password = process.env.RTT_BASIC_PASSWORD;
  if (!username || !password) throw new Error("RTT Basic auth credentials are not configured.");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
    next: { revalidate: 45 },
  });

  if (!response.ok) throw new Error(`Realtime Trains failed (${response.status}).`);

  return (await response.json()) as T;
}

function getRttMode(): RttMode {
  if (process.env.USE_MOCK_DATA === "true") return "mock";
  if (process.env.RTT_AUTH_MODE === "basic") {
    return process.env.RTT_BASIC_USERNAME && process.env.RTT_BASIC_PASSWORD ? "basic" : "mock";
  }
  if (process.env.RTT_ACCESS_TOKEN || process.env.RTT_REFRESH_TOKEN) return "token";
  if (process.env.RTT_BASIC_USERNAME && process.env.RTT_BASIC_PASSWORD) return "basic";
  return "mock";
}

// The API rejects a query duration of 24h or more ("maximum query duration is
// 23 hours 59 minutes"), so cap one minute below that.
const MAX_LOOKAHEAD_MINUTES = 1_439;

function rttLookaheadMinutes() {
  const configured = Number(process.env.RTT_LOOKAHEAD_MINUTES);
  const base =
    Number.isFinite(configured) && configured > 0
      ? Math.round(configured)
      : DEFAULT_LOOKAHEAD_MINUTES;

  return Math.min(MAX_LOOKAHEAD_MINUTES, base);
}

function pickTemporalDate(temporal?: RttTemporal) {
  return parseRttDateTime(
    temporal?.realtimeActual ??
      temporal?.realtimeForecast ??
      temporal?.realtimeEstimate ??
      temporal?.scheduleAdvertised ??
      temporal?.scheduleInternal,
  );
}

function isCatchableService(service: RttLineupService, notBefore?: Date) {
  if (!notBefore) return true;
  const departure = pickTemporalDate(service.temporalData?.departure);
  return Boolean(departure && departure.getTime() >= notBefore.getTime());
}

function isCatchableLegacyService(service: LegacyBoardService, notBefore?: Date) {
  if (!notBefore || !service.runDate) return true;
  const departure = parseLegacyTime(
    service.runDate,
    service.locationDetail?.realtimeDeparture ?? service.locationDetail?.gbttBookedDeparture,
    notBefore,
  );
  return Boolean(departure && departure.getTime() >= notBefore.getTime());
}

function isCambridgeLocationPair(pair: RttLocationPair) {
  const shortCodes = pair.location?.shortCodes ?? [];
  const description = pair.location?.description?.toLowerCase() ?? "";
  return shortCodes.includes(CAMBRIDGE_CRS) || description === "cambridge";
}

function serviceParams(service: RttLineupService) {
  const identity = service.scheduleMetadata?.identity;
  const departureDate = service.scheduleMetadata?.departureDate;
  if (identity && departureDate) return { identity, departureDate };

  const uniqueIdentity = service.scheduleMetadata?.uniqueIdentity?.replace(/^gb-nr:/, "");
  return { uniqueIdentity };
}

function pickPlatform(service: RttLineupService) {
  const platform = service.locationMetadata?.platform;
  return platform?.actual ?? platform?.forecast ?? platform?.planned ?? undefined;
}

function readableDestination(destination?: RttLocationPair[]) {
  return (
    destination?.map((pair) => pair.location?.description).filter(Boolean).join(" / ") ??
    "Cambridge"
  ) || "Cambridge";
}

function statusText(delayMinutes?: number | null, isCancelled?: boolean) {
  if (isCancelled) return "Cancelled";
  if (delayMinutes === undefined || delayMinutes === null) return "Live estimate";
  if (delayMinutes <= 0) return "On time";
  return `${delayMinutes} min late`;
}

function mockDepartures(terminus: Terminus, searchTime?: Date) {
  const now = searchTime ?? new Date();
  const runDate = ymdInLondon(now);
  const profiles: Record<string, { first: number; every: number; duration: number; operator: string; platforms: string[] }> = {
    "kings-cross": {
      first: 28,
      every: 30,
      duration: 50,
      operator: "Great Northern",
      platforms: ["9", "10", "11"],
    },
    "st-pancras": {
      first: 34,
      every: 30,
      duration: 58,
      operator: "Thameslink",
      platforms: ["A", "B"],
    },
    farringdon: {
      first: 38,
      every: 30,
      duration: 64,
      operator: "Thameslink",
      platforms: ["3", "4"],
    },
    "liverpool-street": {
      first: 24,
      every: 30,
      duration: 72,
      operator: "Greater Anglia",
      platforms: ["5", "8", "10"],
    },
  };
  const profile = profiles[terminus.id] ?? profiles["kings-cross"];

  return Array.from({ length: 18 }, (_, index) => {
    const dep = profile.first + index * profile.every;
    return {
    serviceId: `mock-${terminus.id}-${runDate}-${index + 1}`,
    terminusId: terminus.id,
    terminusName: terminus.name,
    crs: terminus.railCrs,
    operator: profile.operator,
    destinationName: "Cambridge",
    departureTime: toIso(addMinutes(now, dep)),
    arrivalTime: toIso(addMinutes(now, dep + profile.duration)),
    platform: profile.platforms[index % profile.platforms.length],
    status: index === 0 ? "On time" : "Live estimate",
    delayMinutes: index === 0 ? 0 : undefined,
    };
  }) satisfies TrainOption[];
}
