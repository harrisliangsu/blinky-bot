/** A known unsupported inference profile, not a transient failure or user refusal. */
export class ModelOnlyUnavailableError extends Error {
  constructor(message:string){super(message);this.name='ModelOnlyUnavailableError'}
}
