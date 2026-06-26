import type {
  AccessJourney,
  OriginSummary,
  RankedRoute,
  RoutesResponse,
  Station,
  TrainOption,
} from "@/app/types";
import { ASSUMPTIONS, TERMINI } from "@/lib/constants";
import type { TflOrigin } from "@/lib/tfl";
import { getAccessJourney, getNearestTubeStation } from "@/lib/tfl";
import { getCambridgeDepartures, usingMockRtt } from "@/lib/rtt";
import { addMinutes, minutesBetween, toIso } from "@/lib/time";

type BuildInput =
  | { kind: "coordinates"; lat: number; lon: number }
  | { kind: "station"; stationId: string; stationName: string };

export async function buildRoutes(input: BuildInput): Promise<RoutesResponse> {
  const now = new Date();
  const errors: string[] = [];
  const nearestStation =
    input.kind === "coordinates"
      ? await getNearestTubeStation(input.lat, input.lon).catch((error: Error) => {
          errors.push(error.message);
          return undefined;
        })
      : undefined;

  if (nearestStation?.distanceMeters && nearestStation.distanceMeters > 2_000) {
    errors.push("No Underground station was found within an easy walk. Use the station picker.");
  }

  const origin = summarizeOrigin(input, nearestStation);
  const tflOrigin = toTflOrigin(input, nearestStation);

  const accessSettled = await Promise.allSettled(
    TERMINI.map(async (terminus) => [terminus.id, await getAccessJourney(tflOrigin, terminus)] as const),
  );
  const accessByTerminus = new Map<string, AccessJourney>();
  for (const result of accessSettled) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    accessByTerminus.set(result.value[0], result.value[1]);
  }

  const trainSettled = await Promise.allSettled(
    TERMINI.map(async (terminus) => {
      const access = accessByTerminus.get(terminus.id);
      const readyAt = access
        ? addMinutes(new Date(access.arrivalTime), terminus.interchangeMinutes)
        : undefined;

      return [
        terminus.id,
        await getCambridgeDepartures(terminus, { notBefore: readyAt }),
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

  const candidates: Omit<RankedRoute, "rank">[] = [];

  for (const terminus of TERMINI) {
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
      });
    }
  }

  const routes = candidates
    .sort((a, b) => {
      const arrivalDelta = Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime);
      if (arrivalDelta !== 0) return arrivalDelta;
      return Date.parse(a.train.departureTime) - Date.parse(b.train.departureTime);
    })
    .slice(0, 3)
    .map((route, index) => ({ ...route, rank: index + 1 }));

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
    sources: {
      tfl: "https://api.tfl.gov.uk",
      rtt: usingMockRtt()
        ? "mock"
        : process.env.RTT_AUTH_MODE === "basic"
          ? "https://api.rtt.io/api/v1"
          : "https://data.rtt.io",
    },
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
