import { UserError } from 'fastmcp';

export function getMapsApiKey() {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new UserError('Set GOOGLE_MAPS_API_KEY to use Maps tools. This must be a Google Maps Platform API key, separate from Google OAuth.');
    return apiKey;
}

export async function mapsFetch(url, options = {}) {
    let response;
    try { response = await fetch(url, options); }
    catch (error) { throw new UserError(`Google Maps request failed: ${error.message || error}`); }
    let data;
    try { data = await response.json(); } catch { data = null; }
    const apiStatusError = data?.status && !['OK', 'ZERO_RESULTS'].includes(data.status);
    if (!response.ok || apiStatusError) {
        const status = data?.error?.status || data?.status || response.status;
        const message = data?.error?.message || data?.error_message || response.statusText || 'Unknown error';
        throw new UserError(`Google Maps API error (${status}): ${message}`);
    }
    return data;
}

export async function placesRequest(url, { method = 'GET', body, fieldMask }) {
    const headers = { 'X-Goog-Api-Key': getMapsApiKey(), 'X-Goog-FieldMask': fieldMask };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return mapsFetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function formatPlace(place) {
    return { placeId: place.id, name: place.displayName?.text || null, address: place.formattedAddress || null, location: place.location || null, types: place.types || [], rating: place.rating ?? null, userRatingCount: place.userRatingCount ?? null, priceLevel: place.priceLevel || null, googleMapsUri: place.googleMapsUri || null };
}

export function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLng = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

export function withinRadius(places, center, radiusMeters) {
    return places.filter((place) => {
        const loc = place.location;
        if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return false;
        return haversineMeters(center, loc) <= radiusMeters;
    });
}

export function dedupePlaces(places, maxResults) {
    const seen = new Set();
    return places.filter((place) => {
        if (!place.placeId || seen.has(place.placeId)) return false;
        seen.add(place.placeId);
        return true;
    }).slice(0, maxResults);
}

export const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel,places.googleMapsUri';
