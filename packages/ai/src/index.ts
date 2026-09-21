// Jev adapter (doc 05). Server-only: the worker imports it; the web app never does.
export * from './evaluator';
export * from './gateway';
export * from './fake';
export * from './redact';
export * from './metrics';
export {
  QUESTIONS_VERSION,
  CLASSIFICATION_QUESTIONS,
  NO_CANDIDATE,
  buildQuestions,
  type Question,
  type QuestionId,
  type QuestionSelection,
} from './questions/v1';
export { INSTRUCTIONS_VERSION } from './instructions/v1.uk';
