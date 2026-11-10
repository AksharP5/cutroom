import type { MiddlewareHandler } from "hono";
import { AGENT_HEADER } from "../../shared/review";
import type { ReviewService } from "./review";

/** Authorize before parsing bodies or entering mutation/repair paths. */
export function projectMutationGuard(
  reviews: ReviewService,
): MiddlewareHandler {
  return async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const id = c.req.param("id");
      // Import is a reserved collection route, not an existing project id.
      reviews.authorize(
        c.req.header(AGENT_HEADER),
        id === "import" ? undefined : id,
      );
    }
    await next();
  };
}
