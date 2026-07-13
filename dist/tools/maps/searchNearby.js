import { z } from 'zod';
import { dedupePlaces, formatPlace, placesRequest, SEARCH_FIELD_MASK } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsSearchNearby',
        description: 'Find places near coordinates, optionally filtering by place types or a keyword.',
        parameters: z.object({
            latitude: z.number().min(-90).max(90).describe('Center latitude in degrees'),
            longitude: z.number().min(-180).max(180).describe('Center longitude in degrees'),
            radiusMeters: z.number().positive().max(50000).describe('Search radius in meters (max 50000)'),
            includedTypes: z.array(z.string()).max(50).optional().describe('Place types to include, e.g. ["restaurant", "gym"]'),
            keyword: z.string().min(1).optional().describe('Free-text filter applied locally against place names, addresses, and types'),
            maxResults: z.number().int().min(1).max(20).optional().default(10).describe('Maximum places to return (default 10, max 20)'),
        }),
        execute: async (args) => {
            const body = { locationRestriction: { circle: { center: { latitude: args.latitude, longitude: args.longitude }, radius: args.radiusMeters } }, maxResultCount: args.keyword ? 20 : args.maxResults };
            if (args.includedTypes?.length) body.includedTypes = args.includedTypes;
            const data = await placesRequest('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
            let places = (data.places || []).map(formatPlace);
            if (args.keyword) {
                const keyword = args.keyword.toLowerCase();
                places = places.filter((place) => [place.name, place.address, ...place.types].filter(Boolean).some((value) => value.toLowerCase().includes(keyword)));
            }
            return JSON.stringify(dedupePlaces(places, args.maxResults));
        },
    });
}
