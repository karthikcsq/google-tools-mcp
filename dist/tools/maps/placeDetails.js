import { z } from 'zod';
import { placesRequest } from './mapsClient.js';

const FIELD_MASK = 'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,regularOpeningHours.weekdayDescriptions,rating,userRatingCount,priceLevel,types,googleMapsUri,location';

export function register(server) {
    server.addTool({
        name: 'mapsPlaceDetails',
        description: 'Get contact, hours, rating, price, type, map link, and location details for a place ID.',
        parameters: z.object({ placeId: z.string().min(1) }),
        execute: async ({ placeId }) => {
            const place = await placesRequest(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, { fieldMask: FIELD_MASK });
            return JSON.stringify({ placeId: place.id || placeId, name: place.displayName?.text || null, address: place.formattedAddress || null, phone: place.nationalPhoneNumber || null, website: place.websiteUri || null, hours: place.regularOpeningHours?.weekdayDescriptions || [], rating: place.rating ?? null, userRatingCount: place.userRatingCount ?? null, priceLevel: place.priceLevel || null, types: place.types || [], googleMapsUri: place.googleMapsUri || null, location: place.location || null });
        },
    });
}
