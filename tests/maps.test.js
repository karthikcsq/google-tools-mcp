import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { UserError } from 'fastmcp';

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
});
