import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { bookingRepository } from '../repositories/booking.repository';
import { paymentRepository } from '../repositories/payment.repository';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../errors/AppError';

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

function toResponse(payment: Payment, pnr: string) {
  return { paymentId: payment.id, pnr, amount: payment.amount, status: payment.status };
}

export const paymentService = {
  // Idempotent on `idempotencyKey`:
  //   key seen + terminal   → replay the stored result (no re-charge)
  //   key seen + in-flight  → 409 PROCESSING (retry later)
  //   key new               → insert PENDING, "execute", store SUCCESS
  // The race within idempotency (two identical retries at once) is resolved by
  // the unique idempotency_key index: one INSERT wins, the loser reads the
  // winner's row instead of charging again.
  async pay(userId: string, pnr: string, idempotencyKey: string | undefined) {
    if (!idempotencyKey) {
      throw new BadRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }

    const booking = await bookingRepository.findByPnr(pnr);
    if (!booking) throw new NotFoundError('Booking');
    if (booking.userId !== userId) throw new ForbiddenError('You do not own this booking');

    // Fast path: this key was already used → return the stored outcome.
    const existing = await paymentRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.status === PaymentStatus.PENDING) {
        throw new ConflictError('PAYMENT_PROCESSING', 'A payment with this key is still processing');
      }
      return toResponse(existing, booking.pnr);
    }

    // New key: claim it by inserting a PENDING row. If a concurrent retry beat us
    // to the insert, the unique constraint throws → read the winner's row.
    let payment;
    try {
      payment = await paymentRepository.createPending({
        bookingId:      booking.id,
        amount:         booking.totalFare,
        idempotencyKey,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await paymentRepository.findByIdempotencyKey(idempotencyKey);
        if (!winner || winner.status === PaymentStatus.PENDING) {
          throw new ConflictError('PAYMENT_PROCESSING', 'A payment with this key is still processing');
        }
        return toResponse(winner, booking.pnr);
      }
      throw err;
    }

    // "Execute" the (mock) payment, then store the terminal result against the key.
    const settled = await paymentRepository.markSuccess(payment.id);
    return toResponse(settled, booking.pnr);
  },
};
