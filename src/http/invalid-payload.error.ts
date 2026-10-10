import { DomainError } from '../domain/errors';
export class InvalidPayloadError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}