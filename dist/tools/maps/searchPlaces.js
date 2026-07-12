import { z } from 'zod';
import { dedupePlaces, formatPlace, placesRequest, SEARCH_FIELD_MASK } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsSearchPlaces',
        description: 'Search Google Places with free text and an optional circular location bias.',
        parameters: z.object({
            query: z.string().min(1),
            locationBias: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusMeters: z.number().positive().max(50000) }).optional(),
            maxResults: z.number().int().min(1).max(20).optional().default(10),
        }),
        execute: async (args) => {
            const body = { textQuery: args.query, maxResultCount: args.maxResults };
            if (args.locationBias) body.locationBias = { circle: { center: { latitude: args.locationBias.latitude, longitude: args.locationBias.longitude }, radius: args.locationBias.radiusMeters } };
            const data = await placesRequest('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
            return JSON.stringify(dedupePlaces((data.places || []).map(formatPlace), args.maxResults));
        },
    });
}
