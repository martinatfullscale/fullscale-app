import { z } from 'zod';
import { insertMonetizationItemSchema, monetizationItems } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  monetization: {
    list: {
      method: 'GET' as const,
      path: '/api/monetization/items',
      responses: {
        200: z.array(z.custom<typeof monetizationItems.$inferSelect>()),
      },
    },
    // Adding create for seeding/testing purposes
    create: {
      method: 'POST' as const,
      path: '/api/monetization/items',
      input: insertMonetizationItemSchema,
      responses: {
        201: z.custom<typeof monetizationItems.$inferSelect>(),
        400: errorSchemas.validation,
      },
    }
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

export type MonetizationItem = z.infer<typeof api.monetization.list.responses[200]>[number];
