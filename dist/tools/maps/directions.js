import { z } from 'zod';
import { UserError } from '../../errors.js';
import { getMapsApiKey, mapsFetch } from './mapsClient.js';

const waypoint = z.union([
    z.string().min(1).describe('An address or place name'),
    z.object({
        latitude: z.number().min(-90).max(90).describe('Latitude in degrees'),
        longitude: z.number().min(-180).max(180).describe('Longitude in degrees'),
    }).describe('Explicit coordinates'),
]);
const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.description,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction.instructions,routes.legs.steps.transitDetails';

// The Routes API documents WALK and BICYCLE as beta travel modes and requires displaying
// this warning to the user for any walking/bicycling route shown:
// https://developers.google.com/maps/documentation/routes/reference/rest/v2/RouteTravelMode
const BETA_TRAVEL_MODES = new Set(['WALK', 'BICYCLE']);
const BETA_TRAVEL_MODE_WARNING = 'WALK and BICYCLE routes are in beta: pedestrian and cycling paths may be incomplete or imprecise in some areas.';

function formatWaypoint(value) {
    return typeof value === 'string' ? { address: value } : { location: { latLng: value } };
}

function formatTransitDetails(details) {
    if (!details) return undefined;
    const line = details.transitLine;
    return {
        line: line?.nameShort || line?.name || null,
        vehicle: line?.vehicle?.type || null,
        headsign: details.headsign || null,
        departureStop: details.stopDetails?.departureStop?.name || null,
        departureTime: details.stopDetails?.departureTime || null,
        arrivalStop: details.stopDetails?.arrivalStop?.name || null,
        arrivalTime: details.stopDetails?.arrivalTime || null,
        stopCount: details.stopCount ?? null,
    };
}

export function register(server) {
    server.addTool({
        name: 'mapsDirections',
        description: 'Get a route summary and turn-by-turn instructions between addresses or coordinates.',
        parameters: z.object({
            origin: waypoint.describe('Route start: address string or {latitude, longitude}'),
            destination: waypoint.describe('Route end: address string or {latitude, longitude}'),
            travelMode: z.enum(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT']).describe('Travel mode for the route'),
            departureTime: z.string().datetime({ offset: true }).optional().describe('RFC 3339 departure time. Omit to depart now. Must be in the future unless travelMode is TRANSIT (the Routes API rejects past times for other modes).'),
        }),
        execute: async (args) => {
            if (args.departureTime && args.travelMode !== 'TRANSIT' && new Date(args.departureTime).getTime() < Date.now()) {
                throw new UserError('departureTime must be in the future for DRIVE/WALK/BICYCLE routes (the Routes API only accepts past departure times for TRANSIT). Omit departureTime to depart now.');
            }
            const body = { origin: formatWaypoint(args.origin), destination: formatWaypoint(args.destination), travelMode: args.travelMode };
            if (args.departureTime) body.departureTime = args.departureTime;
            const data = await mapsFetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': getMapsApiKey(), 'X-Goog-FieldMask': FIELD_MASK }, body: JSON.stringify(body) });
            const route = data.routes?.[0];
            if (!route) return JSON.stringify(null);
            return JSON.stringify({
                description: route.description || null,
                distanceMeters: route.distanceMeters ?? null,
                duration: route.duration || null,
                ...(BETA_TRAVEL_MODES.has(args.travelMode) ? { warning: BETA_TRAVEL_MODE_WARNING } : {}),
                steps: (route.legs || []).flatMap((leg) => (leg.steps || []).map((step) => ({
                    instructions: step.navigationInstruction?.instructions || null,
                    distanceMeters: step.distanceMeters ?? null,
                    duration: step.staticDuration || null,
                    ...(step.transitDetails ? { transit: formatTransitDetails(step.transitDetails) } : {}),
                }))),
            });
        },
    });
}
