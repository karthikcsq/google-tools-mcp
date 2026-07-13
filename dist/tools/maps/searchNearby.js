import { z } from 'zod';
import { dedupePlaces, formatPlace, placesRequest, SEARCH_FIELD_MASK, withinRadius } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsSearchNearby',
        description: 'Find places near coordinates, optionally filtering by place types or a keyword.',
        parameters: z.object({
            latitude: z.number().min(-90).max(90).describe('Center latitude in degrees'),
            longitude: z.number().min(-180).max(180).describe('Center longitude in degrees'),
            radiusMeters: z.number().positive().max(50000).describe('Search radius in meters (max 50000)'),
            includedTypes: z.array(z.string()).max(50).optional().describe('Place types to include, e.g. ["restaurant", "gym"]'),
            keyword: z.string().min(1).optional().describe('Free-text query ranked server-side by Text Search, biased to the radius'),
            maxResults: z.number().int().min(1).max(20).optional().default(10).describe('Maximum places to return (default 10, max 20)'),
        }),
        execute: async (args) => {
            const center = { latitude: args.latitude, longitude: args.longitude };
            let places;
            if (args.keyword) {
                // Nearby Search (New) has no keyword field, and filtering an unfiltered
                // nearby page locally drops semantically-relevant hits (e.g. a Starbucks
                // that lacks the literal word "coffee"). Send the keyword to Text Search,
                // which ranks relevance server-side, bias it to the circle, then enforce
                // the radius locally so the result still honors radiusMeters.
                const body = { textQuery: args.keyword, maxResultCount: 20, locationBias: { circle: { center, radius: args.radiusMeters } } };
                if (args.includedTypes?.length === 1) body.includedType = args.includedTypes[0];
                const data = await placesRequest('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
                places = withinRadius((data.places || []).map(formatPlace), center, args.radiusMeters);
                // Text Search accepts only one includedType; apply any extras as a local
                // filter. Place types are exact canonical tokens, so this is safe (unlike
                // matching free text against names).
                if (args.includedTypes && args.includedTypes.length > 1) {
                    const wanted = new Set(args.includedTypes);
                    places = places.filter((place) => place.types.some((type) => wanted.has(type)));
                }
            } else {
                const body = { locationRestriction: { circle: { center, radius: args.radiusMeters } }, maxResultCount: args.maxResults };
                if (args.includedTypes?.length) body.includedTypes = args.includedTypes;
                const data = await placesRequest('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
                places = (data.places || []).map(formatPlace);
            }
            return JSON.stringify(dedupePlaces(places, args.maxResults));
        },
    });
}
