import { PaymentStatus } from '@prisma/client';
import { prisma } from '../config/prisma';

export const paymentRepository = {
  findByIdempotencyKey(idempotencyKey: string) {
    return prisma.payment.findUnique({ where: { idempotencyKey } });
  },

  // Inserts the payment in PENDING with the idempotency key. The unique index on
  // idempotency_key is what makes two simultaneous identical retries safe: one
  // INSERT wins, the other throws P2002.
  createPending(data: { bookingId: string; amount: number; idempotencyKey: string }) {
    return prisma.payment.create({
      data: { ...data, status: PaymentStatus.PENDING },
    });
  },

  markSuccess(id: string) {
    return prisma.payment.update({ where: { id }, data: { status: PaymentStatus.SUCCESS } });
  },
};
