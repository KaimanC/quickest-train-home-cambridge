import type {
  AccessJourney,
  OriginSummary,
  RankedRoute,
  RoutesResponse,
  Station,
  TrainOption,
} from "@/app/types";
import { ASSUMPTIONS, INTERMEDIATE_RAILHEADS, TERMINI } from "@/lib/constants";
import type { TflOrigin } from "@/lib/tfl";
import { getAccessJourney, getNearestTubeStation } from "@/lib/tfl";
import { getCambridgeDepartures, usingMockRtt } from "@/lib/rtt";
import { addMinutes, minutesBetween, toIso } from "@/lib/time";

type BuildInput =
  | { kind: "coordinates"; lat: number; lon: number; when?: string }
  | { kind: "station"; stationId: string; stationName: string; when?: string };

const ALL_RAILHEADS = [...TERMINI, ...INTERMEDIATE_RAILHEADS];

// An intermediate railhead is only worth a Realtime Trains query when you can
// be ready on its platform no later than this past the fastest central
// terminus. The slack covers the few minutes a mid-route stop departs after
// the terminus, so a near-tie still surfaces as the lower-effort option.
const INTERMEDIATE_READY_TOLERANCE_MS = 5 * 60_000;

export async function buildRoutes(input: BuildInput): Promise<RoutesResponse> {
  // Treat the chosen depart-at time (if any) as "now" for planning. TfL and RTT
  // need a real-time departure to plan against, so an immediate query keeps the
  // current behaviour while a future time shifts the whole plan forward.
  const departAt = input.when ? new Date(input.when) : undefined;
  const now = departAt && !Number.isNaN(departAt.getTime()) ? departAt : new Date();
  const errors: string[] = [];
  const nearestStation =
    input.kind === "coordinates"
      ? await getNearestTubeStation(input.lat, input.lon).catch((error: Error) => {
          errors.push(error.message);
          return undefined;
        })
      : undefined;

  // TfL's Journey Planner only covers Greater London, so a coordinate origin with
  // no nearby Tube station (e.g. starting in Cambridge) would otherwise produce a
  // string of raw 404s. Surface one clear, actionable message instead.
  if (input.kind === "coordinates" && !nearestStation) {
    return {
      generatedAt: toIso(now),
      mock: usingMockRtt(),
      origin: summarizeOrigin(input, undefined),
      nearestStation: undefined,
      routes: [],
      errors: [
        "Your current location looks outside the London Underground network, so we can't plan a Tube leg from here. Search for your London terminal or Tube station above, or pick one of the quick buttons.",
      ],
      assumptions: ASSUMPTIONS,
      sources: rttSources(),
    };
  }

  if (nearestStation?.distanceMeters && nearestStation.distanceMeters > 2_000) {
    errors.push("No Underground station was found within an easy walk. Use the station picker.");
  }

  const origin = summarizeOrigin(input, nearestStation);
  const tflOrigin = toTflOrigin(input, nearestStation);

  const accessSettled = await Promise.allSettled(
    ALL_RAILHEADS.map(
      async (terminus) =>
        [terminus.id, await getAccessJourney(tflOrigin, terminus, departAt)] as const,
    ),
  );
  const accessByTerminus = new Map<string, AccessJourney>();
  for (const result of accessSettled) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    accessByTerminus.set(result.value[0], result.value[1]);
  }

  const readyByTerminus = new Map<string, Date>();
  for (const railhead of ALL_RAILHEADS) {
    const access = accessByTerminus.get(railhead.id);
    if (access) {
      readyByTerminus.set(
        railhead.id,
        addMinutes(new Date(access.arrivalTime), railhead.interchangeMinutes),
      );
    }
  }

  // Earliest you could be ready at any central terminus. Intermediate railheads
  // (e.g. Finsbury Park) are only queried when reaching them isn't slower than
  // this, so we don't spend Realtime Trains calls on a detour that can't win.
  const centralReadyTimes = TERMINI.map((t) => readyByTerminus.get(t.id)?.getTime()).filter(
    (value): value is number => value != null,
  );
  const bestCentralReady = centralReadyTimes.length ? Math.min(...centralReadyTimes) : undefined;

  const railheadsToQuery = ALL_RAILHEADS.filter((railhead) => {
    if (!railhead.intermediate) return true;
    const ready = readyByTerminus.get(railhead.id);
    if (!ready) return false;
    if (bestCentralReady == null) return true;
    return ready.getTime() <= bestCentralReady + INTERMEDIATE_READY_TOLERANCE_MS;
  });

  const trainSettled = await Promise.allSettled(
    railheadsToQuery.map(async (terminus) => {
      const readyAt = readyByTerminus.get(terminus.id);

      return [
        terminus.id,
        await getCambridgeDepartures(terminus, { notBefore: readyAt, searchTime: departAt }),
      ] as const;
    }),
  );
  const trainsByTerminus = new Map<string, TrainOption[]>();
  for (const result of trainSettled) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    trainsByTerminus.set(result.value[0], result.value[1]);
  }

  const candidates: { route: Omit<RankedRoute, "rank">; latestLeaveByMs: number }[] = [];

  for (const terminus of ALL_RAILHEADS) {
    const access = accessByTerminus.get(terminus.id);
    const trains = trainsByTerminus.get(terminus.id) ?? [];
    if (!access) continue;

    const readyAt = addMinutes(new Date(access.arrivalTime), terminus.interchangeMinutes);

    for (const train of trains) {
      const departure = new Date(train.departureTime);
      if (departure.getTime() < readyAt.getTime()) continue;

      const latestLeaveBy = addMinutes(
        departure,
        -(access.durationMinutes + terminus.interchangeMinutes),
      );
      const leaveBy = latestLeaveBy.getTime() < now.getTime() ? now : latestLeaveBy;

      candidates.push({
        latestLeaveByMs: latestLeaveBy.getTime(),
        route: {
          terminus: {
            id: terminus.id,
            name: terminus.name,
            railCrs: terminus.railCrs,
            interchangeMinutes: terminus.interchangeMinutes,
            interchangeNote: terminus.interchangeNote,
          },
          access,
          train,
          readyAt: toIso(readyAt),
          leaveBy: toIso(leaveBy),
          arrivalTime: train.arrivalTime,
          totalMinutes: minutesBetween(now, new Date(train.arrivalTime)),
          warnings: access.statusMessages,
        },
      });
    }
  }

  // The same physical train can be boardable from several railheads (a King's
  // Cross train also calls at Finsbury Park; a Thameslink calls at both St
  // Pancras and Farringdon). Keep only the least-effort boarding point per
  // train — the one you can leave by latest — so the easier option wins instead
  // of the central terminus always shading it on the earliest-departure tie.
  const bestByTrain = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = candidate.route.train.serviceId;
    const existing = bestByTrain.get(key);
    if (!existing || candidate.latestLeaveByMs > existing.latestLeaveByMs) {
      bestByTrain.set(key, candidate);
    }
  }

  const routes = [...bestByTrain.values()]
    .sort((a, b) => {
      const arrivalDelta = Date.parse(a.route.arrivalTime) - Date.parse(b.route.arrivalTime);
      if (arrivalDelta !== 0) return arrivalDelta;
      // Same arrival: prefer the boarding point you can leave for latest.
      return b.latestLeaveByMs - a.latestLeaveByMs;
    })
    .slice(0, 3)
    .map(({ route }, index) => ({ ...route, rank: index + 1 }));

  if (!routes.length && !errors.length) {
    errors.push("No catchable Cambridge trains were found in the next three hours.");
  }

  return {
    generatedAt: toIso(now),
    mock: usingMockRtt(),
    origin,
    nearestStation,
    routes,
    errors,
    assumptions: ASSUMPTIONS,
    sources: rttSources(),
  };
}

function rttSources() {
  return {
    tfl: "https://api.tfl.gov.uk",
    rtt: usingMockRtt()
      ? "mock"
      : process.env.RTT_AUTH_MODE === "basic"
        ? "https://api.rtt.io/api/v1"
        : "https://data.rtt.io",
  };
}

function summarizeOrigin(input: BuildInput, nearestStation?: Station): OriginSummary {
  return input.kind === "station"
    ? {
        kind: "station",
        label: input.stationName,
        stationId: input.stationId,
      }
    : {
        kind: "coordinates",
        label: nearestStation ? `Near ${nearestStation.name}` : "Current location",
        lat: input.lat,
        lon: input.lon,
      };
}

function toTflOrigin(input: BuildInput, nearestStation?: { id?: string; name?: string }): TflOrigin {
  if (input.kind === "station") {
    return {
      kind: "station",
      stationId: input.stationId,
      stationName: input.stationName,
    };
  }

  if (nearestStation?.id && process.env.START_FROM_NEAREST_TUBE === "true") {
    return {
      kind: "station",
      stationId: nearestStation.id,
      stationName: nearestStation.name ?? "Nearest Underground station",
    };
  }

  return { kind: "coordinates", lat: input.lat, lon: input.lon };
}
