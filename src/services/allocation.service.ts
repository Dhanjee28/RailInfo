// booking flow uses bookingRepository.createBookingWithLock instead.
import { ClassType } from '@prisma/client';
import { allocationRepository } from '../repositories/allocation.repository';
import { allocatePassengers, AllocationResult, PassengerInput } from '../domain/allocation';
import { NotFoundError } from '../errors/AppError';

// Re-export the domain types so existing importers keep working.
export type { PassengerInput, PassengerAllocation, AllocationResult } from '../domain/allocation';

export const allocationService = {
  // Reads config + occupancy on the global client (no lock) then runs the pure
  // allocator. This is the check-then-act path with the documented race.
  async allocate(
    trainId:     string,
    journeyDate: Date,
    classType:   ClassType,
    passengers:  PassengerInput[],
  ): Promise<AllocationResult> {
    const config = await allocationRepository.findClassConfig(trainId, classType);
    if (!config) throw new NotFoundError(`${classType} class config for this train`);

    const [freeSeats, racOccupancy, currentWlCount] = await Promise.all([
      allocationRepository.findFreeSeats(trainId, journeyDate, classType),
      allocationRepository.findRacSeatOccupancy(trainId, journeyDate, classType),
      allocationRepository.findCurrentWlCount(trainId, journeyDate, classType),
    ]);

    return allocatePassengers(classType, config, freeSeats, racOccupancy, currentWlCount, passengers);
  },
};
