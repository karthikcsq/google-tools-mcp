import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { UserError } from '../dist/errors.js';

function createMockServer() {
    const tools = new Map();
    return { addTool(tool) { tools.set(tool.name, tool); }, getTools() { return tools; } };
}

function response(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
    return { ok, status, statusText, json: jest.fn().mockResolvedValue(body) };
}

let tools;
beforeAll(async () => {
    const server = createMockServer();
    const { registerMapsTools } = await import('../dist/tools/maps/index.js');
    registerMapsTools(server);
    tools = server.getTools();
});

afterEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    jest.restoreAllMocks();
});

describe('Maps tools', () => {
    it('sends the API key and a narrow Places field mask', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [] }));
        await tools.get('mapsSearchPlaces').execute({ query: 'coffee', maxResults: 10 });
        const options = global.fetch.mock.calls[0][1];
        expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
        expect(options.headers['X-Goog-FieldMask']).toContain('places.id');
        expect(options.headers['X-Goog-FieldMask']).not.toContain('*');
    });

    it('dedupes nearby places by place ID', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [{ id: 'one' }, { id: 'one' }, { id: 'two' }] }));
        const result = JSON.parse(await tools.get('mapsSearchNearby').execute({ latitude: 40, longitude: -86, radiusMeters: 1000, maxResults: 2 }));
        expect(result.map((place) => place.placeId)).toEqual(['one', 'two']);
    });

    it('fails at call time with a clear UserError when the key is missing', async () => {
        const promise = tools.get('mapsPlaceDetails').execute({ placeId: 'abc' });
        await expect(promise).rejects.toEqual(expect.any(UserError));
        await expect(tools.get('mapsPlaceDetails').execute({ placeId: 'abc' })).rejects.toThrow('Set GOOGLE_MAPS_API_KEY to use Maps tools');
    });

    it('maps Google error status and message to UserError', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ error: { status: 'PERMISSION_DENIED', message: 'API not enabled' } }, { ok: false, status: 403, statusText: 'Forbidden' }));
        await expect(tools.get('mapsSearchPlaces').execute({ query: 'coffee', maxResults: 10 })).rejects.toThrow('Google Maps API error (PERMISSION_DENIED): API not enabled');
    });

    it('shapes geocode query parameters', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ status: 'OK', results: [] }));
        await tools.get('mapsGeocode').execute({ address: '123 Main St, West Lafayette' });
        const url = new URL(global.fetch.mock.calls[0][0]);
        expect(url.pathname).toBe('/maps/api/geocode/json');
        expect(url.searchParams.get('address')).toBe('123 Main St, West Lafayette');
        expect(url.searchParams.get('key')).toBe('test-key');
    });

    it('shapes directions and omits the polyline field', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ routes: [] }));
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await tools.get('mapsDirections').execute({ origin: 'Purdue University', destination: { latitude: 40.4, longitude: -86.9 }, travelMode: 'WALK', departureTime: future });
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
        expect(JSON.parse(options.body)).toEqual({ origin: { address: 'Purdue University' }, destination: { location: { latLng: { latitude: 40.4, longitude: -86.9 } } }, travelMode: 'WALK', departureTime: future });
        expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
        expect(options.headers['X-Goog-FieldMask']).toContain('routes.legs.steps.navigationInstruction.instructions');
        expect(options.headers['X-Goog-FieldMask']).toContain('routes.legs.steps.transitDetails');
        expect(options.headers['X-Goog-FieldMask']).not.toContain('polyline');
    });

    it('rejects a past departureTime for non-TRANSIT modes before calling the API', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn();
        await expect(
            tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'DRIVE', departureTime: '2020-01-01T00:00:00Z' })
        ).rejects.toThrow(/departureTime must be in the future/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('allows a past departureTime for TRANSIT and surfaces transit step details', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({
            routes: [{
                distanceMeters: 5000,
                duration: '1200s',
                legs: [{
                    steps: [{
                        distanceMeters: 5000,
                        staticDuration: '1200s',
                        transitDetails: {
                            headsign: 'Downtown',
                            stopCount: 4,
                            transitLine: { nameShort: '4B', vehicle: { type: 'BUS' } },
                            stopDetails: { departureStop: { name: 'Main St' }, arrivalStop: { name: 'Center Sq' } },
                        },
                    }],
                }],
            }],
        }));
        const result = JSON.parse(await tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'TRANSIT', departureTime: '2020-01-01T00:00:00Z' }));
        expect(result.steps[0].transit).toMatchObject({ line: '4B', vehicle: 'BUS', headsign: 'Downtown', departureStop: 'Main St', arrivalStop: 'Center Sq', stopCount: 4 });
    });

    it('uses a top-level field mask (no places. prefix) for place details', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ id: 'abc' }));
        await tools.get('mapsPlaceDetails').execute({ placeId: 'abc' });
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://places.googleapis.com/v1/places/abc');
        expect(options.headers['X-Goog-FieldMask']).toContain('id,displayName');
        expect(options.headers['X-Goog-FieldMask']).not.toContain('places.');
    });

    it('shapes the nearby search body with a circle restriction', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [] }));
        await tools.get('mapsSearchNearby').execute({ latitude: 40.4, longitude: -86.9, radiusMeters: 1500, includedTypes: ['gym'], maxResults: 5 });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body).toEqual({
            locationRestriction: { circle: { center: { latitude: 40.4, longitude: -86.9 }, radius: 1500 } },
            maxResultCount: 5,
            includedTypes: ['gym'],
        });
    });

    it('routes nearby keyword searches through Text Search with a circular bias', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [] }));
        await tools.get('mapsSearchNearby').execute({ latitude: 40.4, longitude: -86.9, radiusMeters: 1500, includedTypes: ['cafe'], keyword: 'coffee', maxResults: 5 });
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
        expect(JSON.parse(options.body)).toEqual({
            textQuery: 'coffee',
            maxResultCount: 20,
            locationBias: { circle: { center: { latitude: 40.4, longitude: -86.9 }, radius: 1500 } },
            includedType: 'cafe',
            strictTypeFiltering: true,
        });
    });

    it('enforces the radius on keyword results and keeps relevant hits the old local filter would drop', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [
            { id: 'inside', displayName: { text: 'Starbucks' }, types: ['cafe'], location: { latitude: 40.4, longitude: -86.9 } },
            { id: 'outside', displayName: { text: 'Coffee Barn' }, types: ['cafe'], location: { latitude: 41.4, longitude: -86.9 } },
        ] }));
        const result = JSON.parse(await tools.get('mapsSearchNearby').execute({ latitude: 40.4, longitude: -86.9, radiusMeters: 1000, keyword: 'coffee', maxResults: 5 }));
        expect(result.map((place) => place.placeId)).toEqual(['inside']);
        expect(result[0].name).toBe('Starbucks');
    });

    it('regression: sets strictTypeFiltering so a high-ranked nonmatching type is not silently returned', async () => {
        // Google documents includedType on Text Search as a ranking bias, not a filter,
        // unless strictTypeFiltering is set: without it, a high-ranked place of the wrong
        // type (e.g. a gas station ranked above nearby restaurants) would come back even
        // though the tool promises type filtering. Assert the request actually asks the
        // API to enforce the type instead of merely biasing toward it.
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ places: [] }));
        await tools.get('mapsSearchNearby').execute({ latitude: 40.4, longitude: -86.9, radiusMeters: 1500, includedTypes: ['restaurant'], keyword: 'lunch', maxResults: 5 });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.includedType).toBe('restaurant');
        expect(body.strictTypeFiltering).toBe(true);
    });

    it('runs one strict Text Search per requested type and merges the results when multiple types are given', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockImplementation((_url, options) => {
            const body = JSON.parse(options.body);
            const byType = {
                cafe: [{ id: 'cafe-match', displayName: { text: 'Starbucks' }, types: ['cafe'], location: { latitude: 40.4, longitude: -86.9 } }],
                bakery: [{ id: 'bakery-match', displayName: { text: 'Corner Bakery' }, types: ['bakery'], location: { latitude: 40.4, longitude: -86.9 } }],
            };
            return Promise.resolve(response({ places: byType[body.includedType] || [] }));
        });
        const result = JSON.parse(await tools.get('mapsSearchNearby').execute({
            latitude: 40.4, longitude: -86.9, radiusMeters: 1000, includedTypes: ['cafe', 'bakery'], keyword: 'coffee', maxResults: 5,
        }));
        // One strict, per-type Text Search call for each requested type, not a single
        // unfiltered call with a local post-filter over a capped-at-20 page.
        expect(global.fetch).toHaveBeenCalledTimes(2);
        for (const [, options] of global.fetch.mock.calls) {
            const body = JSON.parse(options.body);
            expect(body.strictTypeFiltering).toBe(true);
        }
        expect(result.map((place) => place.placeId).sort()).toEqual(['bakery-match', 'cafe-match']);
    });

    it('shapes reverse geocode query parameters and maps the response', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({
            status: 'OK',
            results: [{ formatted_address: '610 Purdue Mall, West Lafayette, IN', place_id: 'place-123', geometry: { location: { lat: 40.4237, lng: -86.9212 } } }],
        }));
        const result = JSON.parse(await tools.get('mapsReverseGeocode').execute({ latitude: 40.4237, longitude: -86.9212 }));
        const url = new URL(global.fetch.mock.calls[0][0]);
        expect(url.pathname).toBe('/maps/api/geocode/json');
        expect(url.searchParams.get('latlng')).toBe('40.4237,-86.9212');
        expect(url.searchParams.get('key')).toBe('test-key');
        expect(result).toEqual({
            formattedAddress: '610 Purdue Mall, West Lafayette, IN',
            placeId: 'place-123',
            location: { lat: 40.4237, lng: -86.9212 },
        });
    });

    it('returns null when reverse geocode finds nothing', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ status: 'ZERO_RESULTS', results: [] }));
        const result = JSON.parse(await tools.get('mapsReverseGeocode').execute({ latitude: 1, longitude: 2 }));
        expect(result).toBeNull();
    });

    it('falls back to the requested coordinates when a matched result has no geometry location', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({
            status: 'OK',
            results: [{ formatted_address: 'Somewhere', place_id: 'place-456' }],
        }));
        const result = JSON.parse(await tools.get('mapsReverseGeocode').execute({ latitude: 1, longitude: 2 }));
        expect(result).toEqual({ formattedAddress: 'Somewhere', placeId: 'place-456', location: { lat: 1, lng: 2 } });
    });

    it('throws a clear UserError instead of a raw crash when a 200 response body is not valid JSON', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, statusText: 'OK',
            json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
        });
        await expect(tools.get('mapsSearchPlaces').execute({ query: 'coffee', maxResults: 10 })).rejects.toThrow(/unparsable response/);
    });

    it('regression: does not leak the API key when a network error message quotes the failed URL', async () => {
        // Geocode/reverse-geocode embed GOOGLE_MAPS_API_KEY in the request URL's query
        // string. If the underlying fetch fails in a way whose error message echoes back
        // the URL it was given (e.g. an invalid-URL TypeError), the raw error message would
        // otherwise carry `?key=test-key` straight into a caller-visible UserError.
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockImplementation((url) => {
            throw new TypeError(`Failed to parse URL from ${url}`);
        });
        let thrown;
        try {
            await tools.get('mapsGeocode').execute({ address: '123 Main St' });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeDefined();
        expect(thrown.message).not.toContain('test-key');
        expect(thrown.message).not.toContain('key=test-key');
        expect(thrown.message).toContain('[REDACTED]');
    });

    it('regression: does not leak the API key when the Google Maps API returns an error alongside the request status', async () => {
        // Same boundary, HTTP-error path: an error body/status line should never be able to
        // carry the key back to the caller even if a future response happens to include the
        // request URL in its error text.
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockImplementation((url) => Promise.resolve(response(
            { status: 'REQUEST_DENIED', error_message: `API key invalid for request ${url}` },
            { ok: false, status: 403, statusText: 'Forbidden' },
        )));
        let thrown;
        try {
            await tools.get('mapsGeocode').execute({ address: '123 Main St' });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeDefined();
        expect(thrown.message).toContain('[REDACTED]');
        expect(thrown.message).not.toContain('key=test-key');
        expect(thrown.message).not.toContain('test-key');
    });

    it('includes a beta warning for WALK routes per the Routes API RouteTravelMode policy', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ routes: [{ distanceMeters: 500, duration: '600s', legs: [{ steps: [] }] }] }));
        const result = JSON.parse(await tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'WALK' }));
        expect(result.warning).toMatch(/beta/i);
    });

    it('includes a beta warning for BICYCLE routes per the Routes API RouteTravelMode policy', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ routes: [{ distanceMeters: 500, duration: '600s', legs: [{ steps: [] }] }] }));
        const result = JSON.parse(await tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'BICYCLE' }));
        expect(result.warning).toMatch(/beta/i);
    });

    it('omits the beta warning for DRIVE and TRANSIT routes', async () => {
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        global.fetch = jest.fn().mockResolvedValue(response({ routes: [{ distanceMeters: 500, duration: '600s', legs: [{ steps: [] }] }] }));
        const drive = JSON.parse(await tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'DRIVE' }));
        const transit = JSON.parse(await tools.get('mapsDirections').execute({ origin: 'A', destination: 'B', travelMode: 'TRANSIT' }));
        expect(drive.warning).toBeUndefined();
        expect(transit.warning).toBeUndefined();
    });
});
