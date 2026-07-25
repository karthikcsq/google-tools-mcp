import { z } from 'zod';
import { dedupePlaces, formatPlace, placesRequest, SEARCH_FIELD_MASK } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsSearchPlaces',
        description: 'Search Google Places with free text and an optional circular location bias.',
        parameters: z.object({
            query: z.string().min(1).describe('Free-text place search, e.g. "vegan restaurants in Lafayette IN"'),
            locationBias: z.object({
                latitude: z.number().min(-90).max(90).describe('Bias center latitude'),
                longitude: z.number().min(-180).max(180).describe('Bias center longitude'),
                radiusMeters: z.number().positive().max(50000).describe('Bias radius in meters (max 50000)'),
            }).optional().describe('Optional circular area to bias results toward'),
            maxResults: z.number().int().min(1).max(20).optional().default(10).describe('Maximum places to return (default 10, max 20)'),
        }),
        execute: async (args) => {
            const body = { textQuery: args.query, maxResultCount: args.maxResults };
            if (args.locationBias) body.locationBias = { circle: { center: { latitude: args.locationBias.latitude, longitude: args.locationBias.longitude }, radius: args.locationBias.radiusMeters } };
            const data = await placesRequest('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
            return JSON.stringify(dedupePlaces((data.places || []).map(formatPlace), args.maxResults));
        },
    });
}
