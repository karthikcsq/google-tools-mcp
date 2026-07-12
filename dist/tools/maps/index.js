import { register as geocode } from './geocode.js';
import { register as reverseGeocode } from './reverseGeocode.js';
import { register as searchNearby } from './searchNearby.js';
import { register as searchPlaces } from './searchPlaces.js';
import { register as placeDetails } from './placeDetails.js';
import { register as directions } from './directions.js';

export function registerMapsTools(server) {
    geocode(server);
    reverseGeocode(server);
    searchNearby(server);
    searchPlaces(server);
    placeDetails(server);
    directions(server);
}
