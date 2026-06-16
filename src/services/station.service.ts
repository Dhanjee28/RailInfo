import { stationRepository } from '../repositories/station.repository';
import { cacheAside } from '../utils/cache';

// Station list rarely changes — cache 24h, explicitly invalidated when an admin
// creates a station (see admin.service).
export const STATIONS_CACHE_KEY = 'stations:all';
const STATIONS_TTL = 60 * 60 * 24;

export const stationService = {
  list() {
    return cacheAside(STATIONS_CACHE_KEY, STATIONS_TTL, () => stationRepository.findAll());
  },
};
