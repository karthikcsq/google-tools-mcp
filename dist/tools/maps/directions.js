import { z } from 'zod';
import { getMapsApiKey, mapsFetch } from './mapsClient.js';

const waypoint = z.union([z.string().min(1), z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })]);
const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.description,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction.instructions';

function formatWaypoint(value) {
    return typeof value === 'string' ? { address: value } : { location: { latLng: value } };
}

export function register(server) {
    server.addTool({
        name: 'mapsDirections',
        description: 'Get a route summary and turn-by-turn instructions between addresses or coordinates.',
        parameters: z.object({ origin: waypoint, destination: waypoint, travelMode: z.enum(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT']), departureTime: z.string().datetime({ offset: true }).optional() }),
        execute: async (args) => {
            const body = { origin: formatWaypoint(args.origin), destination: formatWaypoint(args.destination), travelMode: args.travelMode };
            if (args.departureTime) body.departureTime = args.departureTime;
            const data = await mapsFetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': getMapsApiKey(), 'X-Goog-FieldMask': FIELD_MASK }, body: JSON.stringify(body) });
            const route = data.routes?.[0];
            if (!route) return JSON.stringify(null);
            return JSON.stringify({ description: route.description || null, distanceMeters: route.distanceMeters ?? null, duration: route.duration || null, steps: (route.legs || []).flatMap((leg) => (leg.steps || []).map((step) => ({ instructions: step.navigationInstruction?.instructions || null, distanceMeters: step.distanceMeters ?? null, duration: step.staticDuration || null }))) });
        },
    });
}
