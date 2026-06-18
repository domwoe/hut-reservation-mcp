import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { HutReservationService } from "./service.js";
import { errorResult, okResult } from "./tool-result.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO date YYYY-MM-DD");
const nearSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    radiusKm: z.number().positive().max(500)
  })
  .optional();

const areaInputSchema = {
  country: z.string().min(2).max(3).optional(),
  canton: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  near: nearSchema
};

export function createMcpServer(service: HutReservationService): McpServer {
  const server = new McpServer(
    {
      name: "hut-reservation-mcp",
      version: "0.1.0"
    },
    {
      instructions:
        "Use refresh_hut_catalog before search_huts if the local catalog is empty. search_huts never geocodes inline; for canton filters, refresh_area_cache must be run first with configured Nominatim settings. Use ISO dates only. Booking/cancellation tools are draft-first; do not treat confirm tools as safe headless writes unless experimental writes are enabled and the draft says headless confirmation is available."
    }
  );

  server.registerTool(
    "auth_status",
    {
      title: "Auth Status",
      description: "Report whether hut-reservation.org credentials and an upstream session are available.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => okResult(await service.authStatus())
  );

  server.registerTool(
    "refresh_hut_catalog",
    {
      title: "Refresh Hut Catalog",
      description:
        "Fetch hut-reservation.org hut list and hut details into the local cache. This performs read-only upstream calls and mutates only the local cache.",
      inputSchema: {
        country: z.string().min(2).max(3).optional(),
        limit: z.number().int().positive().max(1000).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.refreshHutCatalog(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "refresh_area_cache",
    {
      title: "Refresh Area Cache",
      description:
        "Reverse-geocode cached hut coordinates through the configured Nominatim-compatible provider. Requires explicit geocoder configuration.",
      inputSchema: {
        force: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.refreshAreaCache(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "search_huts",
    {
      title: "Search Huts",
      description:
        "Search cached huts by country, canton cache, text, and/or distance around coordinates. Does not call a geocoder during search.",
      inputSchema: {
        ...areaInputSchema,
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        return okResult(await service.searchHuts(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "search_hut_availability",
    {
      title: "Search Hut Availability",
      description:
        "Search huts with enough free places for every night in an exact arrival/departure period. Tool dates are ISO YYYY-MM-DD. By default all matched cached huts are checked; maxCandidates intentionally returns a partial result.",
      inputSchema: {
        ...areaInputSchema,
        arrivalDate: dateSchema,
        departureDate: dateSchema,
        partySize: z.number().int().positive().max(200),
        limit: z.number().int().positive().max(100).optional(),
        maxCandidates: z.number().int().positive().max(500).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.searchAvailability(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "prepare_booking",
    {
      title: "Prepare Booking",
      description:
        "Check availability and create a short-lived booking draft. By default this returns a browser handoff URL rather than writing upstream.",
      inputSchema: {
        hutId: z.number().int().positive(),
        arrivalDate: dateSchema,
        departureDate: dateSchema,
        partySize: z.number().int().positive().max(200),
        guestData: z.record(z.string(), z.unknown()).optional(),
        rawReservationPayload: z.unknown().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.prepareBooking(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "confirm_booking",
    {
      title: "Confirm Booking",
      description:
        "Confirm a prepared booking draft. Headless submit only runs when experimental writes are enabled and the draft contains a raw upstream payload.",
      inputSchema: {
        draftId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.confirmBooking(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_bookings",
    {
      title: "List Bookings",
      description: "List authenticated user's reservations through hut-reservation.org myReservations.",
      inputSchema: {
        researchFilter: z.string().optional(),
        open: z.boolean().optional(),
        dateFrom: dateSchema,
        dateTo: dateSchema,
        page: z.number().int().positive().optional(),
        size: z.number().int().positive().max(100).optional(),
        sortList: z.string().optional(),
        sortOrder: z.enum(["ASC", "DESC"]).optional(),
        profiId: z.string().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult({ reservations: await service.listBookings(input) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "prepare_cancellation",
    {
      title: "Prepare Cancellation",
      description:
        "Fetch reservation summary/fee context and create a short-lived cancellation draft. Confirmed cancellation remains browser-handoff only.",
      inputSchema: {
        reservationPublicId: z.string().min(1),
        reservationId: z.number().int().positive().optional(),
        newArrivalDate: dateSchema.optional(),
        newDepartureDate: dateSchema.optional(),
        newPeopleNumber: z.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.prepareCancellation(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "confirm_cancellation",
    {
      title: "Confirm Cancellation",
      description:
        "Confirm a cancellation draft. This currently returns a browser handoff because confirmed-reservation cancellation semantics are not verified.",
      inputSchema: {
        draftId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        return okResult(await service.confirmCancellation(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
