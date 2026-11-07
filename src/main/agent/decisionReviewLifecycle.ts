/** A preference edit invalidates automatic reviews without affecting task runs. */
let generation = 0
export function interruptDecisionReviews(): void { generation++ }
export function decisionReviewGeneration(): number { return generation }
