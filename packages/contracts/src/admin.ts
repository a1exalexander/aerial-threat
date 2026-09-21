// Additive operator API contracts on top of the review/ops DTOs in ./api. Extra response keys are
// stripped by the plain schemas there, so clients that only know those keep working.
import { z } from 'zod';
import { ConnectorDto, OpsDto, ReviewMessageDto, ReviewQueueResponse, envelope } from './api';
import { Id, Timestamp } from './domain';

export const ReviewQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

/** A revision whose latest processing run failed. It has no claim, so it cannot be a ReviewItemDto. */
export const FailedRunDto = z.object({
  runId: Id,
  /** Redacted, first line only. */
  error: z.string().nullable(),
  failedAt: Timestamp,
  messageId: Id,
  /** expectedVersion for POST /v1/admin/messages/:id/reprocess. */
  messageVersion: z.int().positive(),
  revisionId: Id,
  message: ReviewMessageDto,
});
export type FailedRunDto = z.infer<typeof FailedRunDto>;

/** GET /v1/admin/review: ReviewQueueResponse plus the failed runs next to `data`. */
export const AdminReviewResponse = ReviewQueueResponse.extend({ failedRuns: z.array(FailedRunDto) });
export type AdminReviewResponse = z.infer<typeof AdminReviewResponse>;

/** GET /v1/admin/ops: OpsResponse whose connectors also carry `version`, the expectedVersion of a source pause. */
export const AdminOpsDto = OpsDto.extend({ connectors: z.array(ConnectorDto.extend({ version: z.int().positive() })) });
export type AdminOpsDto = z.infer<typeof AdminOpsDto>;
export const AdminOpsResponse = envelope(AdminOpsDto);

/** Response of every operator write; a replay with the same idempotency key returns it unchanged. */
export const AdminCommandResult = z.object({
  auditId: Id,
  entityId: z.string(),
  /** The entity's new version (incidents: revision); send it as the next expectedVersion. */
  version: z.int().positive(),
  /** Split only: the incident created from the selected claims. */
  createdIncidentId: Id.optional(),
  jobIds: z.array(Id),
});
export type AdminCommandResult = z.infer<typeof AdminCommandResult>;
