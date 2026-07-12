import { z } from 'zod';
import { getMapsApiKey, mapsFetch } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsGeocode',
        description: 'Convert an address to coordinates, a formatted address, and a Google place ID.',
        parameters: z.object({ address: z.string().min(1) }),
        execute: async ({ address }) => {
            const params = new URLSearchParams({ address, key: getMapsApiKey() });
            const data = await mapsFetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
            const result = data.results?.[0];
            return JSON.stringify(result ? { location: result.geometry?.location || null, formattedAddress: result.formatted_address || null, placeId: result.place_id || null } : null);
        },
    });
}
