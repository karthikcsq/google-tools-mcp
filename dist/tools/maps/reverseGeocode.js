import { z } from 'zod';
import { getMapsApiKey, mapsFetch } from './mapsClient.js';

export function register(server) {
    server.addTool({
        name: 'mapsReverseGeocode',
        description: 'Convert coordinates to the nearest formatted street address.',
        parameters: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
        execute: async ({ latitude, longitude }) => {
            const params = new URLSearchParams({ latlng: `${latitude},${longitude}`, key: getMapsApiKey() });
            const data = await mapsFetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
            const result = data.results?.[0];
            return JSON.stringify(result ? { formattedAddress: result.formatted_address || null, placeId: result.place_id || null, location: result.geometry?.location || { lat: latitude, lng: longitude } } : null);
        },
    });
}
