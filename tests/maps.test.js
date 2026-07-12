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
        await tools.get('mapsDirections').execute({ origin: 'Purdue University', destination: { latitude: 40.4, longitude: -86.9 }, travelMode: 'WALK', departureTime: '2026-07-12T12:00:00Z' });
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
        expect(JSON.parse(options.body)).toEqual({ origin: { address: 'Purdue University' }, destination: { location: { latLng: { latitude: 40.4, longitude: -86.9 } } }, travelMode: 'WALK', departureTime: '2026-07-12T12:00:00Z' });
        expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
        expect(options.headers['X-Goog-FieldMask']).toContain('routes.legs.steps.navigationInstruction.instructions');
        expect(options.headers['X-Goog-FieldMask']).not.toContain('polyline');
    });
});
