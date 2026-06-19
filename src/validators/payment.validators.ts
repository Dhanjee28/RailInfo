import { z } from 'zod';

// Amount is NOT accepted from the client — the server charges the booking's fare.
// (Trusting a client-sent amount would let users pay whatever they want.)
export const createPaymentSchema = z.object({
  pnr: z.string().trim().min(1),
});
