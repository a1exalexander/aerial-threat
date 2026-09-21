// Question set v1 (doc 05 table). Versioned together with instructions/v1.uk.ts; any change to either
// means a new file and a new QUESTIONS_VERSION, because the version is part of the processing key.
import type { Experimental_EvaluationQuestion as Question } from 'ai';
import * as uk from '../instructions/v1.uk';

export type { Question };

export const QUESTIONS_VERSION = `jev-q1+${uk.INSTRUCTIONS_VERSION}`;

export const CLASSIFICATION_QUESTIONS = [
  'message_kind',
  'temporal_scope',
  'contains_multiple_claims',
  'threat_type',
  'is_tentative',
  'needs_context',
] as const;
export type ClassificationQuestionId = (typeof CLASSIFICATION_QUESTIONS)[number];
export type QuestionId = ClassificationQuestionId | 'place_candidate' | 'relation_candidate';

/** Options every candidate question carries, so Jev can always abstain. */
export const NO_CANDIDATE = ['none', 'unknown'] as const;

const instructions = ({ question, counterExamples = [] }: uk.Text) =>
  [uk.PREAMBLE, question, ...(counterExamples.length ? ['Контрприклади:', ...counterExamples.map((e) => `- ${e}`)] : [])].join(
    '\n',
  );

const STATIC: Record<ClassificationQuestionId, Question> = {
  message_kind: { type: 'choice', instructions: instructions(uk.messageKind), criteria: uk.messageKind.criteria },
  temporal_scope: { type: 'choice', instructions: instructions(uk.temporalScope), criteria: uk.temporalScope.criteria },
  contains_multiple_claims: { type: 'boolean', instructions: instructions(uk.containsMultipleClaims) },
  threat_type: { type: 'choice', instructions: instructions(uk.threatType), criteria: uk.threatType.criteria },
  is_tentative: { type: 'boolean', instructions: instructions(uk.isTentative) },
  needs_context: { type: 'boolean', instructions: instructions(uk.needsContext) },
};

export type QuestionSelection = {
  /** Defaults to all classification questions plus the candidate questions that have candidates. */
  ids?: readonly QuestionId[];
  /** Rule-extracted place IDs (@aerial/geo); `name` comes from the dictionary, never from channel text. */
  placeCandidates?: readonly { id: string; name: string }[];
  /** Incidents pre-selected by time and geography; their summaries travel in state, not here. */
  relationCandidates?: readonly { id: string }[];
};

function candidateChoice(text: typeof uk.placeCandidate, options: [id: string, description: string][]): Question {
  const criteria: Record<string, string> = {};
  for (const [id, description] of options) {
    if ((NO_CANDIDATE as readonly string[]).includes(id)) throw new Error(`candidate id "${id}" is reserved`);
    criteria[id] = description;
  }
  return { type: 'choice', instructions: instructions(text), criteria: { ...criteria, none: text.none, unknown: text.unknown } };
}

export function buildQuestions({ ids, placeCandidates = [], relationCandidates = [] }: QuestionSelection): Record<string, Question> {
  const selected = ids ?? [
    ...CLASSIFICATION_QUESTIONS,
    ...(placeCandidates.length ? (['place_candidate'] as const) : []),
    ...(relationCandidates.length ? (['relation_candidate'] as const) : []),
  ];
  return Object.fromEntries(
    selected.map((id) => [
      id,
      id === 'place_candidate'
        ? candidateChoice(
            uk.placeCandidate,
            placeCandidates.map((c) => [c.id, c.name]),
          )
        : id === 'relation_candidate'
          ? candidateChoice(
              uk.relationCandidate,
              relationCandidates.map((c) => [c.id, uk.relationCandidate.option]),
            )
          : STATIC[id],
    ]),
  );
}
