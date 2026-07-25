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
                //
                // Text Search's includedType is a ranking bias, not a filter, unless
                // strictTypeFiltering is set (Google docs:
                // https://developers.google.com/maps/documentation/places/web-service/text-search#includedtype).
                // This tool promises type filtering, and Text Search only accepts a single
                // includedType per request, so for multiple requested types we run one
                // strict Text Search per type and merge, instead of asking for one type and
                // locally filtering an unfiltered (and therefore incomplete, capped-at-20)
                // page of results by the rest.
                const types = args.includedTypes?.length ? args.includedTypes : [undefined];
                const resultSets = await Promise.all(types.map(async (type) => {
                    const body = { textQuery: args.keyword, maxResultCount: 20, locationBias: { circle: { center, radius: args.radiusMeters } } };
                    if (type) {
                        body.includedType = type;
                        body.strictTypeFiltering = true;
                    }
                    const data = await placesRequest('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body, fieldMask: SEARCH_FIELD_MASK });
                    return (data.places || []).map(formatPlace);
                }));
                places = withinRadius(resultSets.flat(), center, args.radiusMeters);
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
